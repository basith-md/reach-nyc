// Headless test of the routing engine against the real data.
import { readFileSync } from 'node:fs';
import { latLngToCell, gridDisk } from 'h3-js';
import { loadStatic, loadTimetable } from '../src/engine/data';
import { Engine } from '../src/engine/query';
import type { Params } from '../src/types';

const PUB = process.argv[2];
(globalThis as any).fetch = async (u: string) => {
  const b = readFileSync(PUB + u);
  return {
    ok: true, status: 200,
    arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    json: async () => JSON.parse(b.toString()),
  };
};

const main = async () => {
  const g = await loadStatic();
  const raw = readFileSync(PUB + '/data/tiles_h3.bin');
  const ids = Array.from(new BigUint64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)), (x) => x.toString(16));
  const idx = new Map(ids.map((h, i) => [h, i]));
  const tileAt = (lat: number, lng: number) => {
    const c = latLngToCell(lat, lng, 10);
    if (idx.has(c)) return idx.get(c)!;
    for (const n of gridDisk(c, 4)) if (idx.has(n)) return idx.get(n)!;
    return -1;
  };
  const e = new Engine(g);
  const tt = await loadTimetable('wkd', g.S);
  const allModes = { subway: true, bus: true, express: true, rail: true, path: true, ferry: true, classic: true, ebike: true, uber: true, taxi: true };
  const base: Params = {
    origin: tileAt(40.758, -73.9855), day: 'wkd', depSec: 8.5 * 3600, horizonMin: 30, tripsPerWeek: 5, countReturn: true, otherRides: 0,
    tipUber: 0, tipTaxi: 0, taxiWaitMin: 0, includeFirstWait: false, membership: 'nonmember', modes: allModes,
  };
  const none = Object.fromEntries(Object.keys(allModes).map((k) => [k, false])) as any;
  const cases: [string, Partial<Params>][] = [
    ['walk only', { modes: none }],
    ['no cars', { modes: { ...allModes, uber: false, taxi: false } }],
    ['all modes', {}],
  ];
  for (const [name, mod] of cases) {
    const p = { ...base, ...mod } as Params;
    const r = await e.query(p, tt, 1);
    const bands = [0.001, 3.25, 6, 10, 20, 40, 1e9];
    const cnt = new Array(7).fill(0);
    let reach = 0;
    for (let t = 0; t < r.n; t++) {
      let c = Infinity;
      for (let i = r.off[t]; i < r.off[t + 1]; i++) if (r.dur[i] <= 1800 && r.cost[i] < c) c = r.cost[i];
      if (c < Infinity) { reach++; cnt[bands.findIndex((b) => c <= b)]++; }
    }
    console.log(`${name}: ${r.ms.toFixed(0)} ms, labels ${r.stats.labels}, reachable ${(reach * 0.015).toFixed(1)} km2; by band km2: ${cnt.map((c) => (c * 0.015).toFixed(1)).join(' | ')}`);
  }
  const show = (lat: number, lng: number, label: string) => {
    const t = tileAt(lat, lng);
    const list = (e as any).last.opts[t] ?? [];
    console.log(`\n== ${label} (tile ${t}): ${list.length} options`);
    list.forEach((o: any, i: number) => {
      const ex = e.explain(t, i)!;
      console.log(`  $${o.cost.toFixed(2)} ${(o.dur / 60).toFixed(1)} min [${['walk', 'classic', 'ebike', 'transit', 'uber', 'taxi'][o.kind]}]  ` +
        ex.legs.map((l) => `${l.mode}:${l.name}${l.cost ? '($' + l.cost.toFixed(2) + ')' : ''} ${(l.secs / 60).toFixed(0)}m`).join(' > '));
    });
  };
  console.log('bike fee, no membership, 4-min ride: classic', e.bikeFee(base, e.fares(base), 'classic', 240, false, 0)[0], 'e-bike', e.bikeFee(base, e.fares(base), 'ebike', 240, false, 0)[0]);
  show(40.6925, -73.9903, 'Downtown Brooklyn (Borough Hall)');
  show(40.7527, -73.9772, 'Grand Central');
  show(40.7282, -73.9942, 'NoHo');
  show(40.7440, -73.9480, 'Long Island City');
};
main();
