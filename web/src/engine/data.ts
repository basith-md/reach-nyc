// Loads the static data produced by the Python pipeline.
import type { Day } from '../types';

const BASE = '/data/';
async function buf(name: string): Promise<ArrayBuffer> {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`load ${name}: ${r.status}`);
  return r.arrayBuffer();
}
async function json<T = any>(name: string): Promise<T> {
  const r = await fetch(BASE + name);
  if (!r.ok) throw new Error(`load ${name}: ${r.status}`);
  return r.json();
}

export interface RouteMeta { name: string; long: string; mode: string; color: string }

export interface Static {
  N: number;
  lat: Float32Array; lng: Float32Array;     // per tile
  zone: Uint16Array; flag: Uint8Array;
  gOff: Int32Array; gNbr: Int32Array; gLen: Uint16Array;
  // stops
  S: number;
  stopTile: Int32Array;
  stopName: string[]; stopNs: string[];
  routes: RouteMeta[];
  footOff: Int32Array; footTo: Int32Array; footS: Uint16Array; footFlag: Uint8Array;
  egStop: Int32Array; egStopS: Uint16Array; KS: number;
  stopsByTileOff: Int32Array; stopsByTile: Int32Array;
  // docks
  D: number;
  dockTile: Int32Array; dockName: string[];
  egDock: Int32Array; egDockS: Uint16Array; KD: number;
  isDockTile: Uint8Array;
  bikeSpeed: { classic: number[]; ebike: number[] };
  // ride model
  carTile: Int32Array; carWalk: Uint16Array;   // nearest tile a car can stop on + walk seconds
  ride: any;
  rideBins: Record<string, Float32Array | Uint16Array>;
  fares: any;
}

export interface Timetable {
  P: number;
  patStart: Int32Array; patLen: Int32Array; patRoute: Int32Array;
  pstops: Int32Array;
  tripOff: Int32Array;      // P+1 (trip counts per pattern)
  timeOff: Int32Array;      // P   offset into arr/dep
  arr: Int32Array; dep: Int32Array;
  // stop -> (pattern, position)
  spOff: Int32Array; spPat: Int32Array; spPos: Int32Array;
}

function csrFromKeys(keys: Int32Array, n: number): { off: Int32Array; items: Int32Array } {
  const off = new Int32Array(n + 1);
  for (let i = 0; i < keys.length; i++) if (keys[i] >= 0) off[keys[i] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const fill = off.slice(0, n);
  const items = new Int32Array(off[n]);
  for (let i = 0; i < keys.length; i++) if (keys[i] >= 0) items[fill[keys[i]]++] = i;
  return { off, items };
}

export async function loadStatic(): Promise<Static> {
  const [ll, zone, flag, gOff, gNbr, gLen, stops, stopTile, footOff, footTo, footS, footFlag,
    egStop, egStopS, cb, egDock, egDockS, ride, fares] = await Promise.all([
    buf('tiles_ll.bin'), buf('tiles_zone.bin'), buf('tiles_flag.bin'),
    buf('graph_off.bin'), buf('graph_nbr.bin'), buf('graph_len.bin'),
    json('stops.json'), buf('stops_tile.bin'),
    buf('foot_off.bin'), buf('foot_to.bin'), buf('foot_s.bin'), buf('foot_flag.bin'),
    buf('egress_stop.bin'), buf('egress_s.bin'),
    json('citibike.json'), buf('egress_dock.bin'), buf('egress_dock_s.bin'),
    json('ride_model.json'), json('fares.json'),
  ]);
  const llf = new Float32Array(ll);
  const N = llf.length / 2;
  const lat = new Float32Array(N), lng = new Float32Array(N);
  for (let i = 0; i < N; i++) { lat[i] = llf[2 * i]; lng[i] = llf[2 * i + 1]; }
  const st = new Int32Array(stopTile);
  const S = st.length;
  const sbt = csrFromKeys(st, N);
  const dockTile = Int32Array.from(cb.docks.tile as number[]);
  const isDockTile = new Uint8Array(N);
  for (const t of dockTile) isDockTile[t] = 1;
  const binNames = ['hv_ratio', 'hv_spread', 'hv_tolls', 'hv_spf', 'taxi_ratio', 'taxi_spread', 'taxi_tolls', 'taxi_spf', 'detour'];
  const rideBins: Record<string, Float32Array | Uint16Array> = {};
  await Promise.all(binNames.map(async (b) => { rideBins[b] = new Float32Array(await buf(`ride_${b}.bin`)); }));
  await Promise.all(['hv_n', 'taxi_n', 'hv_wait'].map(async (b) => { rideBins[b] = new Uint16Array(await buf(`ride_${b}.bin`)); }));
  const [carTile, carWalk] = await Promise.all([buf('car_tile.bin'), buf('car_walk_s.bin')]);
  return {
    N, lat, lng, zone: new Uint16Array(zone), flag: new Uint8Array(flag),
    gOff: new Int32Array(gOff), gNbr: new Int32Array(gNbr), gLen: new Uint16Array(gLen),
    S, stopTile: st, stopName: stops.names, stopNs: stops.ns, routes: stops.routes,
    footOff: new Int32Array(footOff), footTo: new Int32Array(footTo), footS: new Uint16Array(footS), footFlag: new Uint8Array(footFlag),
    egStop: new Int32Array(egStop), egStopS: new Uint16Array(egStopS), KS: new Int32Array(egStop).length / N,
    stopsByTileOff: sbt.off, stopsByTile: sbt.items,
    D: dockTile.length, dockTile, dockName: cb.docks.name,
    egDock: new Int32Array(egDock), egDockS: new Uint16Array(egDockS), KD: new Int32Array(egDock).length / N,
    isDockTile, bikeSpeed: cb.speed,
    carTile: new Int32Array(carTile), carWalk: new Uint16Array(carWalk),
    ride, rideBins, fares,
  };
}

const ttCache: Partial<Record<Day, Promise<Timetable>>> = {};
export function loadTimetable(day: Day, S: number): Promise<Timetable> {
  if (!ttCache[day]) ttCache[day] = (async () => {
    const [pat, pstopsB, ptrips, arrB, depB] = await Promise.all([
      buf(`tt_${day}_pat.bin`), buf(`tt_${day}_pstops.bin`), buf(`tt_${day}_ptrips.bin`), buf(`tt_${day}_arr.bin`), buf(`tt_${day}_dep.bin`)]);
    const pm = new Int32Array(pat);
    const P = pm.length / 3;
    const patStart = new Int32Array(P), patLen = new Int32Array(P), patRoute = new Int32Array(P);
    for (let p = 0; p < P; p++) { patStart[p] = pm[3 * p]; patLen[p] = pm[3 * p + 1]; patRoute[p] = pm[3 * p + 2]; }
    const tripOff = new Int32Array(ptrips);
    const timeOff = new Int32Array(P);
    let acc = 0;
    for (let p = 0; p < P; p++) { timeOff[p] = acc; acc += (tripOff[p + 1] - tripOff[p]) * patLen[p]; }
    const pstops = new Int32Array(pstopsB);
    // stop -> patterns
    const cnt = new Int32Array(S + 1);
    for (let i = 0; i < pstops.length; i++) cnt[pstops[i] + 1]++;
    for (let i = 0; i < S; i++) cnt[i + 1] += cnt[i];
    const fill = cnt.slice(0, S);
    const spPat = new Int32Array(pstops.length), spPos = new Int32Array(pstops.length);
    for (let p = 0; p < P; p++) for (let k = 0; k < patLen[p]; k++) {
      const s = pstops[patStart[p] + k];
      spPat[fill[s]] = p; spPos[fill[s]] = k; fill[s]++;
    }
    return { P, patStart, patLen, patRoute, pstops, tripOff, timeOff, arr: new Int32Array(arrB), dep: new Int32Array(depB), spOff: cnt, spPat, spPos };
  })();
  return ttCache[day]!;
}
