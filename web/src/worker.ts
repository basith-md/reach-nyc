/// <reference lib="webworker" />
import { cellsToMultiPolygon } from 'h3-js';
import { loadStatic, loadTimetable, type Static } from './engine/data';
import { Engine } from './engine/query';
import type { Day, Params } from './types';

let g: Static | null = null;
let engine: Engine | null = null;
let h3ids: string[] = [];
const ready = (async () => {
  g = await loadStatic();
  engine = new Engine(g);
  const big = new BigUint64Array(await (await fetch('/data/tiles_h3.bin')).arrayBuffer());
  h3ids = Array.from(big, (x) => x.toString(16));
  postMessage({ type: 'ready', n: g.N });
})();

const prevDay: Record<Day, Day> = { wkd: 'wkd', sat: 'wkd', sun: 'sat' };

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  await ready;
  if (msg.type === 'query') {
    const p: Params = msg.params;
    const ttDay = p.depSec < 4 * 3600 ? prevDay[p.day] : p.day;
    const tt = await loadTimetable(ttDay, g!.S);
    const res = await engine!.query(p, tt, msg.id);
    postMessage({ type: 'result', res }, [res.off.buffer, res.dur.buffer, res.cost.buffer, res.kind.buffer] as any);
  } else if (msg.type === 'sim') {
    // simulation: one origin, using the exact settings snapshot from the UI; return km² reachable within T for <= D
    const p: Params = { ...msg.params, origin: msg.origin };
    const ttDay = p.depSec < 4 * 3600 ? prevDay[p.day] : p.day;
    const tt = await loadTimetable(ttDay, g!.S);
    const res = await engine!.query(p, tt, 0);
    const lim = msg.T * 60, D = msg.D + 1e-9;
    // area (km2) of hexagons reachable within T minutes for <= $D
    let n = 0;
    for (let t = 0; t < res.n; t++) {
      for (let i = res.off[t]; i < res.off[t + 1]; i++) if (res.dur[i] <= lim && res.cost[i] <= D) { n++; break; }
    }
    engine!.last = null; // free memory between origins
    postMessage({ type: 'simres', job: msg.job, origin: msg.origin, km2: n * 0.0150475, ms: res.ms });
  } else if (msg.type === 'explain') {
    const ex = engine!.explain(msg.tile, msg.idx);
    const alt = msg.alts ? (msg.alts as number[]).map((i) => engine!.explain(msg.tile, i)) : [];
    postMessage({ type: 'explain', id: msg.id, ex, alt, cars: engine!.carsFor(msg.tile) });
  } else if (msg.type === 'outline') {
    const cells = (msg.tiles as number[]).map((t) => h3ids[t]);
    let poly: number[][][][] = [];
    try { poly = cellsToMultiPolygon(cells, true); } catch { poly = []; }
    postMessage({ type: 'outline', id: msg.id, poly });
  }
};
