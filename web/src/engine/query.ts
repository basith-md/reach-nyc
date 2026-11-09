// The routing engine: walk + Citi Bike + multi-criteria RAPTOR (time x cost) + Uber/taxi.
import { Heap } from './heap';
import type { Static, Timetable } from './data';
import { K_CLASSIC, K_EBIKE, K_TAXI, K_TRANSIT, K_UBER, K_WALK } from '../types';
import type { Explain, Leg, Params, QueryResult } from '../types';

const WALK_MPS = 1.3;
const MAX_ACCESS_WALK = 20 * 60;
const MAX_DOCK_WALK = 10 * 60;
const MAX_STOP_FROM_DOCK = 5 * 60;
const MAX_BIKE_RIDE = 45 * 60;
const DOCK_S = 30;            // time to lock a bike
const MAX_FIRST_WAIT = 3600;  // window of departures considered
const ROUNDS = 4;
const INF = 1e15;
const DEP_TOL = 120;          // leaving up to 2 min earlier still counts as "as good" (keeps bags small)
const XFER_PEN = 120;         // each extra boarding counts as 2 min when comparing routes (not added to reported time)

// state bits
const MTA_MASK = 3, IN_SYS = 4, FERRY_X = 8, BIKE_PAID = 16;

type LegRec =
  | { k: 'walk'; secs: number }
  | { k: 'bike'; type: 'classic' | 'ebike'; w1: number; ride: number; w2: number; d1: number; d2: number; fee: number }
  | { k: 'ride'; p: number; trip: number; from: number; to: number }
  | { k: 'foot'; from: number; secs: number };

interface Label {
  arr: number; cost: number; dep: number; acc: number; st: number; boarded: boolean; pen?: number;
  parent: Label | null; leg: LegRec; stop: number;
}
interface RouteBagItem { l: Label; trip: number; cost: number; dep: number; st: number; from: number; pen: number }
interface Opt { dur: number; cost: number; kind: number; ref: any }

function stateOK(a: number, b: number) {
  const bm = b & MTA_MASK;
  if (bm !== 0 && (a & MTA_MASK) !== bm) return false;
  if ((b & IN_SYS) && !(a & IN_SYS)) return false;
  if ((b & FERRY_X) && !(a & FERRY_X)) return false;
  if ((b & BIKE_PAID) && !(a & BIKE_PAID)) return false;
  return true;
}
function dom(a: Label, b: Label) {
  return a.arr <= b.arr && a.cost <= b.cost + 1e-9 && a.dep - (a.pen ?? 0) >= b.dep - (b.pen ?? 0) - DEP_TOL && stateOK(a.st, b.st);
}
function bagInsert(bag: Label[], l: Label): boolean {
  for (let i = 0; i < bag.length; i++) if (dom(bag[i], l)) return false;
  let j = 0;
  for (let i = 0; i < bag.length; i++) if (!dom(l, bag[i])) bag[j++] = bag[i];
  bag.length = j; bag.push(l);
  return true;
}
function optInsert(list: Opt[], o: Opt): boolean {
  for (const x of list) if (x.dur <= o.dur && x.cost <= o.cost + 1e-9) return false;
  let j = 0;
  for (let i = 0; i < list.length; i++) { const x = list[i]; if (!(o.dur <= x.dur && o.cost <= x.cost + 1e-9)) list[j++] = x; }
  list.length = j; list.push(o);
  return true;
}
function hav(la1: number, lo1: number, la2: number, lo2: number) {
  const r = 6371008.8, p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
  const dp = p2 - p1, dl = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Multi-source Dijkstra on the tile graph, with stamps so arrays are reused. */
class TileSearch {
  dist: Float64Array; stamp: Int32Array; src: Int32Array; cur = 0; heap = new Heap();
  constructor(private g: Static) {
    this.dist = new Float64Array(g.N); this.stamp = new Int32Array(g.N); this.src = new Int32Array(g.N);
  }
  reached(t: number) { return this.stamp[t] === this.cur; }
  /** seeds: tiles + start times + source ids. limitFn(srcId) returns the max time allowed for that source. */
  run(tiles: number[], times: number[], srcs: number[], speed: number, limit: (src: number) => number) {
    const g = this.g, D = this.dist, ST = this.stamp, SRC = this.src, h = this.heap;
    this.cur++; h.clear();
    const cur = this.cur;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (ST[t] !== cur || times[i] < D[t]) { ST[t] = cur; D[t] = times[i]; SRC[t] = srcs[i]; h.push(times[i], t); }
    }
    while (h.size) {
      const u = h.pop(), du = h.topKey;
      if (du > D[u]) continue;
      if (du > limit(SRC[u])) continue;
      for (let e = g.gOff[u], e1 = g.gOff[u + 1]; e < e1; e++) {
        const v = g.gNbr[e], dv = du + g.gLen[e] / speed;
        if (ST[v] !== cur || dv < D[v]) { ST[v] = cur; D[v] = dv; SRC[v] = SRC[u]; h.push(dv, v); }
      }
    }
  }
}

export class Engine {
  g: Static;
  walk: TileSearch; bike: TileSearch;
  // last query (for explain)
  last: { p: Params; tt: Timetable; opts: (Opt[] | undefined)[]; t0: number } | null = null;

  constructor(g: Static) { this.g = g; this.walk = new TileSearch(g); this.bike = new TileSearch(g); }

  hourbin(p: Params) { const h = Math.floor(((p.depSec % 86400) + 86400) % 86400 / 3600); return (p.day === 'wkd' ? 0 : 24) + h; }

  fares(p: Params) {
    const f = this.g.fares;
    const r = Math.max(1, p.tripsPerWeek) * (p.countReturn ? 2 : 1);
    const R = r + Math.max(0, p.otherRides);
    return {
      r,
      mta: Math.min(f.mta.base * R, f.mta.weekly_cap) / R,
      express: Math.min(f.mta.express * R, f.mta.express_weekly_cap) / R,
      path: Math.min(f.path.single, f.path.pass_7day / r, (f.path.pass_30day * 7 / 30) / r),
      ferry: r >= 2 ? f.nyc_ferry.ten_trip / 10 : f.nyc_ferry.single,
      railPeak: f.rail_in_city.cityticket_peak, railOff: f.rail_in_city.cityticket_offpeak,
      peak: f.rail_in_city.peak_windows as number[][],
      amort: (f.citibike.member_annual / 52) / r,
      cb: f.citibike,
    };
  }

  bikeFee(p: Params, F: ReturnType<Engine['fares']>, type: 'classic' | 'ebike', secs: number, manh: boolean, st: number): [number, number] {
    const cb = F.cb, mins = Math.max(1, Math.ceil(secs / 60));
    const non = type === 'classic' ? cb.nonmember_unlock + Math.max(0, mins - cb.nonmember_included_classic_min) * cb.nonmember_per_min
      : cb.nonmember_unlock + mins * cb.nonmember_per_min;
    let mem = type === 'classic' ? Math.max(0, mins - cb.member_included_classic_min) * cb.member_per_min : mins * cb.member_per_min;
    if (type === 'ebike' && manh && mins <= cb.member_manhattan_cap_max_min) mem = Math.min(mem, cb.member_manhattan_ebike_cap);
    if (p.membership === 'nonmember') return [non, st];
    if (p.membership === 'member') return [mem, st | BIKE_PAID];
    const memTotal = mem + ((st & BIKE_PAID) ? 0 : F.amort);
    return [memTotal, st | BIKE_PAID]; // 'annual': membership cost spread over this journey's weekly rides
  }

  async query(p: Params, tt: Timetable, id: number): Promise<QueryResult> {
    const T0 = performance.now();
    const g = this.g, N = g.N, H = p.horizonMin * 60;
    const F = this.fares(p);
    const opts: (Opt[] | undefined)[] = new Array(N);
    const put = (t: number, o: Opt) => { if (o.dur > H) return; (opts[t] ??= []); optInsert(opts[t]!, o); };
    const o = p.origin;
    const isManh = (t: number) => (g.flag[t] & 1) === 1;
    const hb = this.hourbin(p);
    let labels = 0;

    // ---------- 1. walking from origin
    const W = this.walk;
    W.run([o], [0], [0], WALK_MPS, () => Math.max(H, MAX_ACCESS_WALK));
    const walkT = new Float64Array(N).fill(INF);
    for (let t = 0; t < N; t++) if (W.reached(t)) { walkT[t] = W.dist[t]; put(t, { dur: walkT[t], cost: 0, kind: K_WALK, ref: null }); }

    // ---------- 2. Citi Bike directly from origin (per bike type), relative times
    const bikeTypes = (['classic', 'ebike'] as const).filter((b) => p.modes[b]);
    const speedOf = (type: 'classic' | 'ebike') => g.bikeSpeed[type][hb];
    const overhead = g.fares.citibike.dock_overhead_s;
    const directBike: Record<string, { arr: Float64Array; src: Int32Array; seedW: Float64Array } | undefined> = {};
    for (const type of bikeTypes) {
      const tiles: number[] = [], times: number[] = [], srcs: number[] = [];
      const seedW = new Float64Array(g.D).fill(INF);
      for (let j = 0; j < g.D; j++) {
        const dt = g.dockTile[j];
        if (walkT[dt] <= MAX_DOCK_WALK) { tiles.push(dt); times.push(walkT[dt] + overhead); srcs.push(j); seedW[j] = walkT[dt]; }
      }
      if (!tiles.length) continue;
      const B = this.bike;
      B.run(tiles, times, srcs, speedOf(type), (j) => seedW[j] + overhead + MAX_BIKE_RIDE);
      const arr = new Float64Array(N).fill(INF), src = new Int32Array(N).fill(-1);
      for (let j = 0; j < g.D; j++) { const dt = g.dockTile[j]; if (B.reached(dt)) { arr[dt] = B.dist[dt]; src[dt] = B.src[dt]; } }
      directBike[type] = { arr, src, seedW };
      const kind = type === 'classic' ? K_CLASSIC : K_EBIKE;
      // bike -> dock -> walk to every tile
      for (let t = 0; t < N; t++) {
        for (let q = 0; q < g.KD; q++) {
          const j = g.egDock[t * g.KD + q]; if (j < 0) break;
          const dt = g.dockTile[j]; if (arr[dt] >= INF) continue;
          const sj = src[dt], ride = arr[dt] - (seedW[sj] + overhead);
          const [fee] = this.bikeFee(p, F, type, ride, isManh(g.dockTile[sj]) || isManh(dt), 0);
          const w2 = g.egDockS[t * g.KD + q];
          put(t, { dur: arr[dt] + DOCK_S + w2, cost: fee, kind, ref: { k: 'bike', type, w1: seedW[sj], ride, w2, d1: sj, d2: j, fee } });
        }
      }
    }

    // ---------- 3. transit runs
    const transitOn = (['subway', 'bus', 'express', 'rail', 'path', 'ferry'] as const).some((m) => p.modes[m]);
    const modeOn = (m: string) => m === 'free' ? (p.modes.ferry || p.modes.bus) : (p.modes as any)[m];
    let late = false;
    let t0base = p.depSec;
    if (p.depSec < 4 * 3600) { late = true; t0base = p.depSec + 86400; }
    const runs = p.includeFirstWait ? [t0base] : [t0base, t0base + 900, t0base + 1800, t0base + 2700];
    if (transitOn) {
      // best (duration, cost) per stop across all departure runs; egress to tiles is done once afterwards
      const stopOpts: (Opt[] | undefined)[] = new Array(g.S);
      for (const t0 of runs) labels += this.transitRun(p, tt, F, t0, H, walkT, directBike, stopOpts, modeOn, speedOf, overhead);
      this.egress(p, F, H, stopOpts, put, speedOf, overhead);
    }

    // ---------- 4. Uber / taxi
    const zo = g.zone[o];
    if (zo && (p.modes.uber || p.modes.taxi)) {
      for (let t = 0; t < N; t++) {
        for (const which of ['hv', 'taxi'] as const) {
          if (which === 'hv' ? !p.modes.uber : !p.modes.taxi) continue;
          const c = this.car(p, which, o, t, hb);
          if (c) put(t, { dur: c.dur, cost: c.price, kind: which === 'hv' ? K_UBER : K_TAXI, ref: null });
        }
      }
    }

    // ---------- pack
    const off = new Int32Array(N + 1);
    for (let t = 0; t < N; t++) off[t + 1] = off[t] + (opts[t]?.length ?? 0);
    const M = off[N];
    const dur = new Float32Array(M), cost = new Float32Array(M), kind = new Uint8Array(M);
    for (let t = 0; t < N; t++) {
      const l = opts[t]; if (!l) continue;
      l.sort((a, b) => a.cost - b.cost);
      for (let i = 0; i < l.length; i++) { dur[off[t] + i] = l[i].dur; cost[off[t] + i] = l[i].cost; kind[off[t] + i] = l[i].kind; }
    }
    this.last = { p, tt, opts, t0: t0base };
    return { id, n: N, off, dur, cost, kind, ms: performance.now() - T0, stats: { labels, runs: transitOn ? runs.length : 0 } };
  }

  car(p: Params, which: 'hv' | 'taxi', o0: number, t0: number, hb: number) {
    // cars only stop on streets they may use (not in parks, plazas, campuses or on highways): walk the rest
    const g = this.g, o = g.carTile[o0], t = g.carTile[t0];
    if (o < 0 || t < 0) return null;
    const walkA = g.carWalk[o0], walkB = g.carWalk[t0];
    const zo = g.zone[o], zd = g.zone[t];
    if (!zo || !zd) return null;
    const crow = hav(g.lat[o], g.lng[o], g.lat[t], g.lng[t]);
    if (crow < 250) return null;
    const m = g.ride[which], b = g.rideBins;
    const pair = zo * 264 + zd;
    const det = (b.detour as Float32Array)[pair] || g.ride.hv.detour_global;
    const miles = crow * det / 1609.34;
    const spf = Math.min(2, Math.max(0.5, (b[`${which}_spf`] as Float32Array)[pair] || 1));
    const mph = m.mph[hb] * spf;
    const mins = miles / mph * 60;
    const [a, bm, c] = m.coef[hb];
    const n = (b[`${which}_n`] as Uint16Array)[pair];
    const ratio = (b[`${which}_ratio`] as Float32Array)[pair] || 1;
    const observed = ratio !== 1;
    const fare = Math.max(m.floor[hb], (a + bm * miles + c * mins) * ratio);
    const tolls = (b[`${which}_tolls`] as Float32Array)[pair] || 0;
    const tip = fare * (which === 'hv' ? p.tipUber : p.tipTaxi) / 100;
    const wait = which === 'hv' ? (p.includeFirstWait ? (b.hv_wait as Uint16Array)[zo * 48 + hb] : 0) : p.taxiWaitMin * 60;
    return { dur: mins * 60 + wait + walkA + walkB, price: fare + tip + tolls, fare, tip, tolls, wait, miles, mins, n, observed, walkA, walkB };
  }

  transitRun(p: Params, tt: Timetable, F: ReturnType<Engine['fares']>, t0: number, H: number, walkT: Float64Array,
    directBike: Record<string, { arr: Float64Array; src: Int32Array; seedW: Float64Array } | undefined>,
    stopOpts: (Opt[] | undefined)[], modeOn: (m: string) => boolean,
    speedOf: (t: 'classic' | 'ebike') => number, overhead: number): number {
    const g = this.g, S = g.S, N = g.N, ifw = p.includeFirstWait;
    const best: (Label[] | undefined)[] = new Array(S);
    let prevBags: (Label[] | undefined)[] = new Array(S);
    let marked: number[] = [];
    let count = 0;
    const isManh = (t: number) => (g.flag[t] & 1) === 1;
    const routes = g.routes;
    const day = p.day;

    const insert = (bags: (Label[] | undefined)[], s: number, l: Label, mk: number[]) => {
      const reachT = l.boarded ? l.arr - l.dep : l.arr - t0;
      if (reachT > H) return false;
      const b = (best[s] ??= []);
      if (!bagInsert(b, l)) return false;
      const rb = bags[s];
      if (!rb) { bags[s] = [l]; mk.push(s); } else bagInsert(rb, l);
      count++;
      return true;
    };

    // seeds (round 0): walk access + bike access
    const seedDep = ifw ? t0 : Infinity;
    for (let t = 0; t < N; t++) {
      const w = walkT[t];
      if (w > MAX_ACCESS_WALK || w > H) continue;
      for (let i = g.stopsByTileOff[t]; i < g.stopsByTileOff[t + 1]; i++) {
        const s = g.stopsByTile[i];
        insert(prevBags, s, { arr: t0 + w, cost: 0, dep: seedDep, acc: w, st: 0, boarded: false, parent: null, leg: { k: 'walk', secs: w }, stop: s }, marked);
      }
    }
    for (const type of ['classic', 'ebike'] as const) {
      const db = directBike[type]; if (!db) continue;
      for (let j = 0; j < g.D; j++) {
        const dt = g.dockTile[j]; if (db.arr[dt] >= INF) continue;
        const sj = db.src[dt], ride = db.arr[dt] - (db.seedW[sj] + overhead);
        const [fee, st] = this.bikeFee(p, F, type, ride, isManh(g.dockTile[sj]) || isManh(dt), 0);
        for (let q = 0; q < g.KS; q++) {
          const s = g.egStop[dt * g.KS + q]; if (s < 0) break;
          const w2 = g.egStopS[dt * g.KS + q]; if (w2 > MAX_STOP_FROM_DOCK) break;
          const acc = db.arr[dt] + DOCK_S + w2;
          insert(prevBags, s, { arr: t0 + acc, cost: fee, dep: seedDep, acc, st, boarded: false, parent: null,
            leg: { k: 'bike', type, w1: db.seedW[sj], ride, w2, d1: sj, d2: j, fee }, stop: s }, marked);
        }
      }
    }

    const railFare = (td: number) => {
      if (day !== 'wkd') return F.railOff;
      const m = (td % 86400) / 60;
      return F.peak.some(([a, b]) => m >= a && m < b) ? F.railPeak : F.railOff;
    };
    const board = (st: number, mode: string, td: number): [number, number] => {
      const mta = st & MTA_MASK;
      let s2 = st & ~IN_SYS;
      switch (mode) {
        case 'subway':
          if (st & IN_SYS) return [0, st];
          if (mta === 2) return [0, (s2 & ~MTA_MASK)];
          return [F.mta, (s2 & ~MTA_MASK) | 1];
        case 'bus':
          if (mta) return [0, s2 & ~MTA_MASK];
          return [F.mta, (s2 & ~MTA_MASK) | 2];
        case 'express':
          if (mta) return [Math.max(0, F.express - F.mta), s2 & ~MTA_MASK];
          return [F.express, (s2 & ~MTA_MASK) | 2];
        case 'rail': return [railFare(td), s2];
        case 'path': return [F.path, s2];
        case 'ferry':
          if (st & FERRY_X) return [0, s2 & ~FERRY_X];
          return [F.ferry, s2 | FERRY_X];
        default: return [0, s2];
      }
    };
    const rbDom = (a: RouteBagItem, b: RouteBagItem) => a.trip <= b.trip && a.cost <= b.cost + 1e-9 && a.dep - a.pen >= b.dep - b.pen && stateOK(a.st, b.st);

    const patMin = new Int32Array(tt.P).fill(-1);
    for (let k = 1; k <= ROUNDS && marked.length; k++) {
      const bags: (Label[] | undefined)[] = new Array(S);
      const nextMarked: number[] = [];
      // collect patterns
      const pats: number[] = [];
      for (const s of marked) {
        for (let i = tt.spOff[s]; i < tt.spOff[s + 1]; i++) {
          const pp = tt.spPat[i], pos = tt.spPos[i];
          if (patMin[pp] < 0) { patMin[pp] = pos; pats.push(pp); } else if (pos < patMin[pp]) patMin[pp] = pos;
        }
      }
      for (const pp of pats) {
        const start = patMin[pp]; patMin[pp] = -1;
        const route = routes[tt.patRoute[pp]];
        if (!modeOn(route.mode)) continue;
        const len = tt.patLen[pp], ps = tt.patStart[pp], nT = tt.tripOff[pp + 1] - tt.tripOff[pp], to = tt.timeOff[pp];
        if (!nT) continue;
        const isSub = route.mode === 'subway';
        let rbag: RouteBagItem[] = [];
        for (let pos = start; pos < len; pos++) {
          const s = tt.pstops[ps + pos];
          // alight
          for (const rb of rbag) {
            const a = tt.arr[to + rb.trip * len + pos];
            const st = isSub ? (rb.st | IN_SYS) : (rb.st & ~IN_SYS);
            insert(bags, s, { arr: a, cost: rb.cost, dep: rb.dep, pen: rb.pen, acc: 0, st, boarded: true, parent: rb.l,
              leg: { k: 'ride', p: pp, trip: rb.trip, from: rb.from, to: pos }, stop: s }, nextMarked);
          }
          // board
          const prev = prevBags[s];
          if (prev && pos < len - 1) {
            for (const l of prev) {
              let lo = 0, hi = nT;
              while (lo < hi) { const m = (lo + hi) >> 1; if (tt.dep[to + m * len + pos] >= l.arr) hi = m; else lo = m + 1; }
              if (lo >= nT) continue;
              const td = tt.dep[to + lo * len + pos];
              if (!l.boarded && td - l.arr > MAX_FIRST_WAIT) continue;
              const [fc, st] = board(l.st, route.mode, td);
              const dep = l.boarded ? l.dep : (ifw ? t0 : td - l.acc);
              const item: RouteBagItem = { l, trip: lo, cost: l.cost + fc, dep, st, from: pos, pen: l.boarded ? (l.pen ?? 0) + XFER_PEN : 0 };
              let dominated = false;
              for (const x of rbag) if (rbDom(x, item)) { dominated = true; break; }
              if (dominated) continue;
              rbag = rbag.filter((x) => !rbDom(item, x));
              rbag.push(item);
            }
          }
        }
      }
      // footpaths from stops reached by riding this round
      const rideMarked = nextMarked.slice();
      for (const s of rideMarked) {
        const src = bags[s]!.filter((l) => l.leg.k === 'ride');
        for (let e = g.footOff[s]; e < g.footOff[s + 1]; e++) {
          const t = g.footTo[e], secs = g.footS[e], inSysOK = g.footFlag[e] === 1;
          for (const l of src) {
            const st = (inSysOK && (l.st & IN_SYS)) ? l.st : (l.st & ~IN_SYS);
            insert(bags, t, { arr: l.arr + secs, cost: l.cost, dep: l.dep, pen: l.pen, acc: 0, st, boarded: true, parent: l, leg: { k: 'foot', from: s, secs }, stop: t }, nextMarked);
          }
        }
      }
      // Citi Bike between stops (bike transfers)
      if (k < ROUNDS) for (const type of ['classic', 'ebike'] as const) {
        if (!p.modes[type]) continue;
        const seedsT: number[] = [], seedsTime: number[] = [], seedsSrc: number[] = [];
        const seedInfo: { l: Label; w1: number; dock: number }[] = [];
        for (const s of rideMarked) {
          let fl: Label | null = null;
          for (const l of bags[s]!) if (l.leg.k === 'ride' && (!fl || l.arr < fl.arr)) fl = l;
          if (!fl) continue;
          const st = g.stopTile[s];
          for (let q = 0; q < g.KD; q++) {
            const j = g.egDock[st * g.KD + q]; if (j < 0) break;
            const w = g.egDockS[st * g.KD + q]; if (w > MAX_STOP_FROM_DOCK) break;
            seedsT.push(g.dockTile[j]); seedsTime.push(fl.arr + w + overhead); seedsSrc.push(seedInfo.length);
            seedInfo.push({ l: fl, w1: w, dock: j });
          }
        }
        if (!seedsT.length) continue;
        const B = this.bike;
        B.run(seedsT, seedsTime, seedsSrc, speedOf(type), (i) => seedInfo[i].l.arr + seedInfo[i].w1 + overhead + MAX_BIKE_RIDE);
        for (let j = 0; j < g.D; j++) {
          const dt = g.dockTile[j]; if (!B.reached(dt)) continue;
          const si = seedInfo[B.src[dt]];
          if (g.dockTile[si.dock] === dt) continue;
          const ride = B.dist[dt] - (si.l.arr + si.w1 + overhead);
          const [fee, st0] = this.bikeFee(p, F, type, ride, isManh(g.dockTile[si.dock]) || isManh(dt), si.l.st);
          for (let q = 0; q < g.KS; q++) {
            const s = g.egStop[dt * g.KS + q]; if (s < 0) break;
            const w2 = g.egStopS[dt * g.KS + q]; if (w2 > MAX_STOP_FROM_DOCK) break;
            insert(bags, s, { arr: B.dist[dt] + DOCK_S + w2, cost: si.l.cost + fee, dep: si.l.dep, pen: (si.l.pen ?? 0) + XFER_PEN, acc: 0, st: st0 & ~IN_SYS, boarded: true, parent: si.l,
              leg: { k: 'bike', type, w1: si.w1, ride, w2, d1: si.dock, d2: j, fee }, stop: s }, nextMarked);
          }
        }
      }
      prevBags = bags;
      marked = nextMarked;
    }

    // ---------- collect (duration, cost) per stop for the shared egress step
    for (let s = 0; s < S; s++) {
      const bag = best[s]; if (!bag) continue;
      for (const l of bag) {
        if (!l.boarded) continue;
        const d = l.arr - l.dep;
        if (d <= H) optInsert((stopOpts[s] ??= []), { dur: d, cost: l.cost, kind: K_TRANSIT, ref: l });
      }
    }
    return count;
  }

  /** From stops to every tile: walk (table lookup) and Citi Bike (one Dijkstra per bike type). Durations are relative. */
  egress(p: Params, F: ReturnType<Engine['fares']>, H: number, stopOpts: (Opt[] | undefined)[], put: (t: number, o: Opt) => void,
    speedOf: (t: 'classic' | 'ebike') => number, overhead: number) {
    const g = this.g, N = g.N, S = g.S;
    const isManh = (t: number) => (g.flag[t] & 1) === 1;
    for (let t = 0; t < N; t++) {
      for (let q = 0; q < g.KS; q++) {
        const s = g.egStop[t * g.KS + q]; if (s < 0) break;
        const so = stopOpts[s]; if (!so) continue;
        const w = g.egStopS[t * g.KS + q];
        for (const o of so) put(t, { dur: o.dur + w, cost: o.cost, kind: K_TRANSIT, ref: { l: o.ref, egress: { k: 'walk', secs: w } } });
      }
    }
    for (const type of ['classic', 'ebike'] as const) {
      if (!p.modes[type]) continue;
      const seedsT: number[] = [], seedsTime: number[] = [], seedsSrc: number[] = [];
      const seedInfo: { o: Opt; w1: number; dock: number; t0: number }[] = [];
      for (let s = 0; s < S; s++) {
        const so = stopOpts[s]; if (!so) continue;
        let fo: Opt | null = null;
        for (const o of so) if (!fo || o.dur < fo.dur) fo = o;
        const st = g.stopTile[s];
        for (let q = 0; q < g.KD; q++) {
          const j = g.egDock[st * g.KD + q]; if (j < 0) break;
          const w = g.egDockS[st * g.KD + q]; if (w > MAX_STOP_FROM_DOCK) break;
          const t0 = fo!.dur + w + overhead;
          seedsT.push(g.dockTile[j]); seedsTime.push(t0); seedsSrc.push(seedInfo.length);
          seedInfo.push({ o: fo!, w1: w, dock: j, t0 });
        }
      }
      if (!seedsT.length) continue;
      const B = this.bike;
      B.run(seedsT, seedsTime, seedsSrc, speedOf(type), (i) => Math.min(H, seedInfo[i].t0 + MAX_BIKE_RIDE));
      for (let t = 0; t < N; t++) {
        for (let q = 0; q < g.KD; q++) {
          const j = g.egDock[t * g.KD + q]; if (j < 0) break;
          const dt = g.dockTile[j]; if (!B.reached(dt)) continue;
          const si = seedInfo[B.src[dt]];
          if (g.dockTile[si.dock] === dt) continue;
          const ride = B.dist[dt] - si.t0;
          const l = si.o.ref as Label;
          const [fee] = this.bikeFee(p, F, type, ride, isManh(g.dockTile[si.dock]) || isManh(dt), l.st);
          const w2 = g.egDockS[t * g.KD + q];
          put(t, { dur: B.dist[dt] + DOCK_S + w2, cost: si.o.cost + fee, kind: K_TRANSIT,
            ref: { l, egress: { k: 'bike', type, w1: si.w1, ride, w2, d1: si.dock, d2: j, fee } } });
        }
      }
    }
  }

  /** Uber and taxi to a tile, always (even when another option is better), for the hover card. */
  carsFor(tile: number) {
    const L = this.last; if (!L) return [];
    const out: { kind: number; dur: number; cost: number; n: number; observed: boolean; miles: number }[] = [];
    const hb = this.hourbin(L.p);
    if (L.p.modes.uber) { const c = this.car(L.p, 'hv', L.p.origin, tile, hb); if (c) out.push({ kind: K_UBER, dur: c.dur, cost: c.price, n: c.n, observed: c.observed, miles: c.miles }); }
    if (L.p.modes.taxi) { const c = this.car(L.p, 'taxi', L.p.origin, tile, hb); if (c) out.push({ kind: K_TAXI, dur: c.dur, cost: c.price, n: c.n, observed: c.observed, miles: c.miles }); }
    return out;
  }

  // ---------------------------------------------------------------- explain
  explain(tile: number, idx: number): Explain | null {
    const L = this.last; if (!L) return null;
    const list = L.opts[tile]; if (!list || !list[idx]) return null;
    const o = list[idx], g = this.g, tt = L.tt, p = L.p;
    const zone = g.ride.zones.name[g.zone[tile]] || '';
    const legs: Leg[] = [];
    const bikeLegs = (b: any): Leg[] => [
      { mode: 'walk', name: 'Walk to dock', color: '', secs: b.w1, to: g.dockName[b.d1] },
      { mode: b.type, name: b.type === 'ebike' ? 'Citi Bike e-bike' : 'Citi Bike classic', color: '', secs: b.ride + DOCK_S, cost: b.fee, from: g.dockName[b.d1], to: g.dockName[b.d2] },
      { mode: 'walk', name: 'Walk', color: '', secs: b.w2 },
    ];
    if (o.kind === K_WALK) legs.push({ mode: 'walk', name: 'Walk', color: '', secs: o.dur });
    else if (o.kind === K_CLASSIC || o.kind === K_EBIKE) legs.push(...bikeLegs(o.ref));
    else if (o.kind === K_UBER || o.kind === K_TAXI) {
      const c = this.car(p, o.kind === K_UBER ? 'hv' : 'taxi', p.origin, tile, this.hourbin(p))!;
      if (c.walkA >= 60) legs.push({ mode: 'walk', name: 'Walk to the nearest street a car can stop on', color: '', secs: c.walkA });
      if (c.wait > 0) legs.push({ mode: 'wait', name: o.kind === K_UBER ? 'Wait for car' : 'Hail a cab', color: '', secs: c.wait });
      const parts = [`$${c.fare.toFixed(2)} fare`];
      if (c.tolls > 0) parts.push(`$${c.tolls.toFixed(2)} tolls`);
      if (c.tip > 0) parts.push(`$${c.tip.toFixed(2)} tip`);
      legs.push({ mode: o.kind === K_UBER ? 'uber' : 'taxi', name: o.kind === K_UBER ? 'Uber / Lyft' : 'Yellow / green taxi', color: '',
        secs: c.mins * 60, cost: c.price, note: `${c.miles.toFixed(1)} mi · ${parts.join(' + ')} · ${c.observed ? `based on ${c.n.toLocaleString()} trips` : 'estimate (few trips on this route)'}` });
      if (c.walkB >= 60) legs.push({ mode: 'walk', name: 'Walk in (cars can\'t drive here)', color: '', secs: c.walkB });
    } else if (o.kind === K_TRANSIT) {
      const chain: Label[] = [];
      for (let l: Label | null = o.ref.l; l; l = l.parent) chain.push(l);
      chain.reverse();
      let prevArr = -1;
      for (const l of chain) {
        const lg = l.leg;
        if (lg.k === 'walk') { legs.push({ mode: 'walk', name: 'Walk', color: '', secs: lg.secs, to: g.stopName[l.stop] }); }
        else if (lg.k === 'bike') { legs.push(...bikeLegs(lg)); legs[legs.length - 1].to = g.stopName[l.stop]; }
        else if (lg.k === 'foot') { legs.push({ mode: 'walk', name: 'Transfer', color: '', secs: lg.secs, to: g.stopName[l.stop] }); }
        else if (lg.k === 'ride') {
          const len = tt.patLen[lg.p], to = tt.timeOff[lg.p];
          const tdep = tt.dep[to + lg.trip * len + lg.from], tarr = tt.arr[to + lg.trip * len + lg.to];
          const firstBoard = !l.parent?.boarded;
          if (prevArr >= 0 && tdep - prevArr > 60 && (!firstBoard || p.includeFirstWait)) legs.push({ mode: 'wait', name: 'Wait', color: '', secs: tdep - prevArr });
          const r = g.routes[tt.patRoute[lg.p]];
          legs.push({ mode: r.mode, name: r.name, color: r.color, secs: tarr - tdep, cost: l.cost - (l.parent?.cost ?? 0),
            from: g.stopName[tt.pstops[tt.patStart[lg.p] + lg.from]], to: g.stopName[tt.pstops[tt.patStart[lg.p] + lg.to]], note: r.long });
        }
        prevArr = l.arr;
      }
      const eg = o.ref.egress;
      if (eg.k === 'walk') legs.push({ mode: 'walk', name: 'Walk', color: '', secs: eg.secs });
      else legs.push(...bikeLegs(eg));
    }
    return { tile, zone, dur: o.dur, cost: o.cost, kind: o.kind, legs };
  }
}
