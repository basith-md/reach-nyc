import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import { latLngToCell, gridDisk } from 'h3-js';
import type { Explain, Leg, ModeKey, Params, QueryResult } from './types';
import { K_CLASSIC, K_EBIKE, K_TAXI, K_TRANSIT, K_UBER, K_WALK } from './types';
import { setupWhatif } from './whatif';
import { setupAbout } from './about';
import { setupSim, landFrac } from './sim';
import { inject } from '@vercel/analytics';

inject();   // Vercel Web Analytics (page views; no-op locally in dev)

// ------------------------------------------------------------------ cost bands (sequential: pale -> dark)
const BANDS = [
  // below a subway fare: green scale (pale -> deep)
  { max: 0.001, label: '$0', sub: 'walking', color: '#E2F3E6' },
  { max: 1, label: 'up to $1', sub: '', color: '#A9DDB6' },
  { max: 2, label: 'up to $2', sub: '', color: '#5FBC7C' },
  { max: 2.995, label: 'under $3', sub: 'cheaper than a subway fare', color: '#1B8A4C' },
  // a fare and above: yellow -> red -> dark
  { max: 3.25, label: 'up to $3.25', sub: 'one fare', color: '#FCCC0A' },
  { max: 6, label: 'up to $6', sub: 'two fares, or a bike ride', color: '#FF9E1B' },
  { max: 10, label: 'up to $10', sub: '', color: '#FF6319' },
  { max: 20, label: 'up to $20', sub: '', color: '#EE352E' },
  { max: 40, label: 'up to $40', sub: '', color: '#A51C30' },
  { max: Infinity, label: 'over $40', sub: '', color: '#4E1530' },
];
const hexRGB = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BAND_RGB = BANDS.map((b) => hexRGB(b.color));
const bandOf = (c: number) => { for (let i = 0; i < BANDS.length; i++) if (c <= BANDS[i].max) return i; return BANDS.length - 1; };
const TILE_KM2 = 0.0150475; // H3 res-10 average
// money-budget mode: colour by the fastest trip that fits the budget (green = quick, red = slow)
let moneyH = 60;           // longest trip considered in money mode (minutes); set from the Simulation panel
let timeCap = Infinity;    // optional spending cap in time mode ($); set from the Simulation panel
const TBANDS = [
  { max: 10, label: 'under 10 min', color: '#1B8A4C' },
  { max: 15, label: '10–15 min', color: '#5FBC7C' },
  { max: 20, label: '15–20 min', color: '#FCCC0A' },
  { max: 30, label: '20–30 min', color: '#FF9E1B' },
  { max: 45, label: '30–45 min', color: '#EE352E' },
  { max: Infinity, label: '45 min or more', color: '#A51C30' },
];
const TBAND_RGB = TBANDS.map((b) => hexRGB(b.color));
const tbandOf = (m: number) => { for (let i = 0; i < TBANDS.length; i++) if (m <= TBANDS[i].max) return i; return TBANDS.length - 1; };

// ------------------------------------------------------------------ modes (categorical identity: official line colours)
const MODES: { key: ModeKey; label: string; b: string; c: string; t?: string }[] = [
  { key: 'subway', label: 'Subway', b: 'M', c: '#0039A6' },
  { key: 'bus', label: 'Bus', b: 'B', c: '#0039A6' },
  { key: 'express', label: 'Express bus', b: 'X', c: '#00933C' },
  { key: 'rail', label: 'LIRR / Metro-North', b: 'RR', c: '#0F61A9' },
  { key: 'path', label: 'PATH', b: 'P', c: '#004D6F' },
  { key: 'ferry', label: 'Ferry', b: 'F', c: '#00A1DE' },
  { key: 'classic', label: 'Citi Bike', b: 'CB', c: '#0070C0' },
  { key: 'ebike', label: 'E-bike', b: 'E', c: '#00B2E3' },
  { key: 'uber', label: 'Uber / Lyft', b: 'U', c: '#111', t: '#fff' },
  { key: 'taxi', label: 'Taxi', b: 'T', c: '#FCCC0A', t: '#111' },
];
const MODE_STYLE: Record<string, { c: string; t?: string; b: string }> = {
  walk: { c: '#A7A9AC', b: '' }, wait: { c: '#d9d4c8', b: '' },
  bus: { c: '#0039A6', b: 'B' }, express: { c: '#00933C', b: 'X' }, rail: { c: '#0F61A9', b: 'RR' },
  path: { c: '#004D6F', b: 'P' }, ferry: { c: '#00A1DE', b: 'F' }, free: { c: '#00A1DE', b: 'F' },
  classic: { c: '#0070C0', b: 'CB' }, ebike: { c: '#00B2E3', b: 'E' }, uber: { c: '#111', b: 'U' }, taxi: { c: '#FCCC0A', t: '#111', b: 'T' },
};
const KIND_NAME = ['Walk', 'Citi Bike classic', 'Citi Bike e-bike', 'Transit', 'Uber / Lyft', 'Taxi'];

// ------------------------------------------------------------------ state
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params: Params = {
  origin: -1, day: 'wkd', depSec: 8.5 * 3600, horizonMin: 30, tripsPerWeek: 1, countReturn: true, otherRides: 0,
  tipUber: 0, tipTaxi: 0, taxiWaitMin: 0, includeFirstWait: false, membership: 'nonmember',
  modes: { subway: true, bus: true, express: true, rail: true, path: true, ferry: true, classic: true, ebike: true, uber: true, taxi: true },
};
let T = 30;                 // display budget (minutes)
let M = 5;                  // money budget ($), used when budgetMode === 'money'
let budgetMode: 'time' | 'money' = 'time';
const lim = () => (budgetMode === 'time' ? T : moneyH);   // time limit shown on the map (minutes)
const capNow = () => (budgetMode === 'money' ? M : timeCap); // spending cap shown on the map ($, Infinity = none)
// a new search is needed when the time horizon or the spending cap grows past what the last search covered
const needsQuery = () => lim() > params.horizonMin || capNow() > (params.maxCost ?? Infinity);
const refresh = () => { if (!result) return; if (needsQuery()) runQuery(); else { recompute(false); hoverTile = -1; } };
let N = 0;
let h3ids: string[] = [];
let h3index = new Map<string, number>();
let docks: { lat: number[]; lng: number[]; name: string[] } | null = null;
let result: QueryResult | null = null;
let fastestMin = new Float32Array(0);   // per tile, minutes (1e6 = unreachable)
let cheapCost = new Float32Array(0);    // per tile, cheapest cost within T
let cheapIdx = new Int32Array(0);
let version = 0;
let animT = 0, animStart = 0, animFrom = 0, animTo = 0, animating = false;
let outline: number[][][] = [];
let show3D = false, showDocks = false;
let border: number[][][] = [];
let simActive = false, simLayers: any[] = [];   // connectivity simulation view
fetch('/data/nyc_boundary.geojson').then((r) => r.json()).then((g) => { border = g.features[0].geometry.coordinates; if (result) render(); });
const tileIdx: number[] = [];

// ------------------------------------------------------------------ worker
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let qid = 0, latestQ = 0, eid = 0, latestE = 0, oid = 0, latestO = 0;
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'ready') { N = m.n; onReady(); }
  else if (m.type === 'result') { if (m.res.id === latestQ) onResult(m.res); }
  else if (m.type === 'explain') { if (m.id === latestE) renderTip(m.ex, m.alt, m.cars); }
  else if (m.type === 'outline') { if (m.id === latestO) { outline = m.poly.flat(); render(); } }
};

// ------------------------------------------------------------------ map
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/positron',
  center: [-73.955, 40.735], zoom: 11.3, minZoom: 9, maxZoom: 17, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay as any);

map.on('style.load', () => {
  const set = (id: string, prop: string, v: any) => { if (map.getLayer(id)) map.setPaintProperty(id, prop as any, v); };
  set('background', 'background-color', '#f4f1ea');
  set('water', 'fill-color', '#c9d6dc');
  set('park', 'fill-color', '#e4e7d8');
  set('landuse_residential', 'fill-color', '#efebe2');
  set('building', 'fill-color', '#e7e2d8');
  for (const l of map.getStyle().layers) {
    if (l.type === 'symbol' && map.getLayoutProperty(l.id, 'text-field')) {
      map.setPaintProperty(l.id, 'text-color', '#3c3c3c');
      map.setPaintProperty(l.id, 'text-halo-color', 'rgba(244,241,234,.9)');
    }
  }
});

// toggle: hide roads, labels and buildings so the coloured hexagons read clearly
const baseBtn = document.createElement('button');
baseBtn.id = 'baseToggle'; baseBtn.type = 'button'; baseBtn.textContent = 'Hide roads & labels'; baseBtn.setAttribute('aria-pressed', 'false');
document.body.appendChild(baseBtn);
let plainMap = false;
const wasHidden = new Set<string>();
baseBtn.addEventListener('click', () => {
  plainMap = !plainMap;
  for (const l of map.getStyle().layers) {
    if (!(l.type === 'line' || l.type === 'symbol' || l.id.startsWith('building'))) continue;
    if (plainMap) { if (map.getLayoutProperty(l.id, 'visibility') === 'none') wasHidden.add(l.id); map.setLayoutProperty(l.id, 'visibility', 'none'); }
    else if (!wasHidden.has(l.id)) map.setLayoutProperty(l.id, 'visibility', 'visible');
  }
  baseBtn.textContent = plainMap ? 'Show roads & labels' : 'Hide roads & labels';
  baseBtn.setAttribute('aria-pressed', String(plainMap));
});

const pinEl = document.createElement('div');
pinEl.className = 'pin';
const pin = new maplibregl.Marker({ element: pinEl, draggable: true }).setLngLat([-73.9855, 40.758]);
pin.on('dragend', () => { const ll = pin.getLngLat(); setOrigin(ll.lat, ll.lng); });
map.on('click', (e) => { pin.setLngLat(e.lngLat); setOrigin(e.lngLat.lat, e.lngLat.lng); });

function nearestTile(lat: number, lng: number): number {
  const c = latLngToCell(lat, lng, 10);
  const hit = h3index.get(c);
  if (hit !== undefined) return hit;
  for (let k = 1; k <= 6; k++) for (const nb of gridDisk(c, k)) { const j = h3index.get(nb); if (j !== undefined) return j; }
  return -1;
}

async function onReady() {
  const big = new BigUint64Array(await (await fetch('/data/tiles_h3.bin')).arrayBuffer());
  h3ids = Array.from(big, (x) => x.toString(16));
  h3ids.forEach((h, i) => h3index.set(h, i));
  for (let i = 0; i < N; i++) tileIdx.push(i);
  const cb = await (await fetch('/data/citibike.json')).json();
  docks = cb.docks;
  fastestMin = new Float32Array(N).fill(1e6); cheapCost = new Float32Array(N); cheapIdx = new Int32Array(N).fill(-1);
  pin.addTo(map);
  const ll = pin.getLngLat();
  setOrigin(ll.lat, ll.lng);
}

function setOrigin(lat: number, lng: number) {
  const t = nearestTile(lat, lng);
  if (t < 0) { status('That spot is outside the five boroughs, or on water. Try somewhere else.'); return; }
  params.origin = t;
  // clear the old reach right away so the new pin visibly takes over while it computes
  if (result) { fastestMin.fill(1e6); version++; outline = []; tip.hidden = true; hoverTile = -1; render(); }
  runQuery(true);
}

let queryTimer = 0;
function runQuery(immediate = false) {
  if (params.origin < 0) return;
  clearTimeout(queryTimer);
  queryTimer = window.setTimeout(() => {
    params.horizonMin = Math.max(lim(), 15);
    params.maxCost = isFinite(capNow()) ? capNow() : undefined;   // prune journeys over the cap (much faster)
    latestQ = ++qid;
    pinEl.classList.add('busy');
    status('Finding every route…');
    worker.postMessage({ type: 'query', id: latestQ, params: structuredClone(params) });
  }, immediate ? 0 : 250);
}

function onResult(res: QueryResult) {
  result = res;
  pinEl.classList.remove('busy');
  status(`Computed in ${(res.ms / 1000).toFixed(1)} s · ${res.stats.runs ? `${res.stats.runs} departures checked` : 'no transit'} · hover any hexagon for the route`);
  recompute(true);
}

/** Time mode: per tile, cheapest option within T (+ fastest overall, for the reveal animation).
 *  Money mode: per tile, fastest option costing <= M (cheapCost/cheapIdx then hold that option). */
function recompute(animate: boolean) {
  if (!result) return;
  const { off, dur, cost } = result;
  const L = lim(), limS = L * 60, money = budgetMode === 'money', Mx = M + 1e-9, capT = timeCap + 1e-9;
  for (let t = 0; t < N; t++) {
    let f = 1e6, c = Infinity, ci = -1;
    if (!money) {
      for (let i = off[t]; i < off[t + 1]; i++) {
        if (cost[i] > capT) continue;                 // optional spending cap (Simulation panel)
        if (dur[i] / 60 < f) f = dur[i] / 60;
        if (dur[i] <= limS && cost[i] < c) { c = cost[i]; ci = i - off[t]; }
      }
    } else {
      let bd = Infinity;
      for (let i = off[t]; i < off[t + 1]; i++) if (cost[i] <= Mx && dur[i] <= limS && dur[i] < bd) { bd = dur[i]; c = cost[i]; ci = i - off[t]; }
      f = bd / 60;
    }
    fastestMin[t] = ci >= 0 ? f : 1e6;
    cheapCost[t] = c; cheapIdx[t] = ci;
  }
  version++;
  updateStats();
  requestOutline();
  if (animate) { animFrom = 0; animTo = L; startAnim(); }
  else { if (animT < L) { animFrom = animT; animTo = L; startAnim(); } else { animT = L; render(); } }
}

function startAnim() {
  animStart = performance.now(); animating = true;
  outline = [];
  const step = (now: number) => {
    const k = Math.min(1, (now - animStart) / 1300);
    const e = 1 - Math.pow(1 - k, 3);
    animT = animFrom + (animTo - animFrom) * e;
    render();
    if (k < 1) requestAnimationFrame(step); else { animating = false; render(); }
  };
  requestAnimationFrame(step);
}

let outlineTimer = 0;
function requestOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    const tiles: number[] = [];
    for (let t = 0; t < N; t++) if (fastestMin[t] <= lim()) tiles.push(t);
    latestO = ++oid;
    worker.postMessage({ type: 'outline', id: latestO, tiles });
  }, 150);
}

function render() {
  const layers: any[] = [
    new H3HexagonLayer({
      id: 'reach', data: tileIdx, getHexagon: (i: number) => h3ids[i],
      beforeId: 'highway_path',
      highPrecision: false, coverage: 1, stroked: false, filled: true,
      extruded: show3D, elevationScale: 1, getElevation: (i: number) => (isFinite(cheapCost[i]) ? 30 + cheapCost[i] * 45 : 0),
      getFillColor: (i: number) => { const c = budgetMode === 'money' ? TBAND_RGB[tbandOf(fastestMin[i])] : BAND_RGB[bandOf(cheapCost[i])]; return [c[0], c[1], c[2], show3D ? 235 : 190]; },
      pickable: true, autoHighlight: true, highlightColor: [17, 17, 17, 90],
      extensions: [new DataFilterExtension({ filterSize: 1 })],
      getFilterValue: (i: number) => fastestMin[i],
      filterRange: [0, Math.max(0.01, animT)],
      filterSoftRange: [0, Math.max(0, animT - 2.5)],
      updateTriggers: { getFillColor: [version, show3D], getFilterValue: version, getElevation: version },
      material: { ambient: 0.55, diffuse: 0.6, shininess: 8 },
      onHover: onHover,
    } as any),
  ];
  if (!animating && outline.length) {
    layers.push(new PathLayer({
      id: 'outline', data: outline, getPath: (d: any) => d, getColor: [17, 17, 17, 230], getWidth: 2.5, widthUnits: 'pixels',
      jointRounded: true, capRounded: true, beforeId: 'waterway_line_label',
    } as any));
  }
  if (showDocks && docks) {
    layers.push(new ScatterplotLayer({
      id: 'docks', data: docks.lat.map((_, i) => i), getPosition: (i: number) => [docks!.lng[i], docks!.lat[i]],
      getRadius: 3.2, radiusUnits: 'pixels', getFillColor: [0, 112, 192, 230], stroked: true, getLineColor: [255, 255, 255, 255],
      lineWidthUnits: 'pixels', getLineWidth: 1, beforeId: 'waterway_line_label',
    } as any));
  }
  if (simActive) { layers.length = 0; layers.push(...simLayers); }   // simulation heatmap replaces the single-pin view
  if (border.length) {
    // the city limit: white halo + bold ink line, above the hexagons, below labels
    for (const [id, color, width] of [['border-halo', [255, 255, 255, 220], 6], ['border', [17, 17, 17, 255], 2.5]] as const) {
      layers.push(new PathLayer({ id, data: border, getPath: (d: any) => d, getColor: color as any, getWidth: width, widthUnits: 'pixels',
        jointRounded: true, capRounded: true, beforeId: 'waterway_line_label' } as any));
    }
  }
  overlay.setProps({ layers });
}

// ------------------------------------------------------------------ stats + legend
function updateStats() {
  const money = budgetMode === 'money';
  const bands: { label: string; sub?: string; color: string }[] = money ? TBANDS : BANDS;
  const counts = new Array(bands.length).fill(0);
  let total = 0;
  for (let t = 0; t < N; t++) if (fastestMin[t] <= lim()) { counts[money ? tbandOf(fastestMin[t]) : bandOf(cheapCost[t])]++; total++; }
  $('areaTotal').textContent = (total * TILE_KM2).toFixed(1);
  // effective area: same formula as the simulation. R = average straight-line distance to the reachable hexagons,
  // land fraction = NYC land within R / (pi R^2), effective = area / land fraction
  const effEl = $('effLine');
  if (tileLat && tileLng && params.origin >= 0 && total > 0) {
    const kx = 84.3, ky = 111.32, ox = tileLng[params.origin] * kx, oy = tileLat[params.origin] * ky;
    const dist = (t: number) => Math.hypot(tileLng![t] * kx - ox, tileLat![t] * ky - oy);
    let dsum = 0;
    for (let t = 0; t < N; t++) if (fastestMin[t] <= lim()) dsum += dist(t);
    const R = dsum / total;
    let land = 0;
    for (let t = 0; t < N; t++) if (dist(t) <= R) land++;
    const f = landFrac(land * TILE_KM2, R);
    effEl.innerHTML = `Effective area <b>${(total * TILE_KM2 / f).toFixed(1)} km²</b> <span>· ${Math.round(f * 100)}% land within ${R.toFixed(1)} km (avg reach)</span>`;
  } else effEl.textContent = '';
  $('heroSub').innerHTML = money ? `km² reachable for <b>$${M.toFixed(2)}</b> <small style="color:var(--muted)">(trips up to ${moneyH} min)</small>` : `km² reachable in <b>${T}</b> min${isFinite(timeCap) ? ` <small style="color:var(--muted)">(up to $${timeCap.toFixed(2)})</small>` : ''}`;
  $('legendHead').textContent = money ? 'Fastest way there takes…' : 'Cheapest way there costs…';
  const bar = $('bandBar');
  bar.innerHTML = bands.map((b, i) => `<i style="background:${b.color};flex-grow:${counts[i]}"></i>`).join('');
  let cum = 0;
  $('legend').innerHTML = bands.map((b, i) => {
    cum += counts[i];
    return `<li class="${counts[i] ? '' : 'dim'}"><span class="sw" style="--c:${b.color}"></span>
      <span><b>${b.label}</b>${b.sub ? ` <span style="color:var(--muted)">· ${b.sub}</span>` : ""}</span>
      <span class="km" title="cumulative area you can reach this ${money ? 'fast' : 'cheaply'} or better">${(cum * TILE_KM2).toFixed(1)} km²</span></li>`;
  }).join('');
  const o = params.origin;
  if (o >= 0) {
    const ex = (window as any).__zoneNames as string[] | undefined;
    $('originName').textContent = ex ? `From ${ex[zoneOf(o)] || 'here'}` : 'From the pin';
  }
}
let tileLat: Float32Array | null = null, tileLng: Float32Array | null = null;   // tile centres, for the effective-area circle
fetch('/data/tiles_ll.bin').then((r) => r.arrayBuffer()).then((b) => {
  const f = new Float32Array(b), n = f.length / 2;
  const la = new Float32Array(n), lo = new Float32Array(n);
  for (let i = 0; i < n; i++) { la[i] = f[2 * i]; lo[i] = f[2 * i + 1]; }
  tileLng = lo; tileLat = la;
  if (result) updateStats();
});
let zoneArr: Uint16Array | null = null;
const zoneOf = (t: number) => (zoneArr ? zoneArr[t] : 0);
fetch('/data/tiles_zone.bin').then((r) => r.arrayBuffer()).then((b) => { zoneArr = new Uint16Array(b); });
fetch('/data/ride_model.json').then((r) => r.json()).then((m) => { (window as any).__zoneNames = m.zones.name; updateStats(); });

function status(s: string) { $('status').textContent = s; }

// ------------------------------------------------------------------ hover
const tip = $('tip');
let hoverTile = -1, mouse = { x: 0, y: 0 };
function onHover(info: any) {
  const t = info.index ?? -1;
  if (info.x !== undefined) mouse = { x: info.x, y: info.y };
  if (t < 0 || !result || simActive || fastestMin[t] > animT || fastestMin[t] > lim()) { hoverTile = -1; tip.hidden = true; return; }
  positionTip();
  if (t === hoverTile) return;
  hoverTile = t;
  const { off, dur, cost, kind } = result;
  // cheapest within T, fastest overall, and the best of each car/bike kind
  let fi = -1;
  for (let i = off[t]; i < off[t + 1]; i++) if (fi < 0 || dur[i] < dur[fi]) fi = i;
  const alts: number[] = [];
  if (fi >= 0) alts.push(fi - off[t]);
  for (const k of [K_EBIKE, K_CLASSIC]) {
    let bi = -1;
    for (let i = off[t]; i < off[t + 1]; i++) if (kind[i] === k && (bi < 0 || cost[i] < cost[bi])) bi = i;
    if (bi >= 0) alts.push(bi - off[t]);
  }
  if (budgetMode === 'money') {
    // money mode: also the cheapest option within the trip-length limit (always the last alt)
    let ci = -1;
    for (let i = off[t]; i < off[t + 1]; i++) if (dur[i] <= moneyH * 60 && (ci < 0 || cost[i] < cost[ci] || (cost[i] === cost[ci] && dur[i] < dur[ci]))) ci = i;
    alts.push(ci - off[t]);
  }
  latestE = ++eid;
  worker.postMessage({ type: 'explain', id: latestE, tile: t, idx: cheapIdx[t], alts });
}
function positionTip() {
  const w = tip.offsetWidth || 330, h = tip.offsetHeight || 200;
  let x = mouse.x + 18, y = mouse.y + 18;
  if (x + w > innerWidth - 8) x = mouse.x - w - 18;
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const fmtMin = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;
const fmt$ = (c: number) => (c < 0.005 ? '$0' : `$${c.toFixed(2)}`);
function legHTML(l: Leg) {
  const st = l.mode === 'subway' ? { c: l.color || '#808183', b: l.name, t: ['#FCCC0A'].includes(l.color.toUpperCase()) ? '#111' : '#fff' } : MODE_STYLE[l.mode] ?? { c: '#888', b: '?' };
  const label = l.mode === 'subway' ? `${l.name} train` : l.mode === 'bus' || l.mode === 'express' ? `${l.name} bus` : l.name;
  const sub = l.from && l.to ? `${l.from} to ${l.to}` : l.to ? `to ${l.to}` : l.note ?? '';
  const name = st.b.length > 3 ? st.b.slice(0, 3) : st.b;
  return `<li><span class="lb" style="--c:${st.c};--t:${st.t ?? '#fff'}">${name}</span>
    <span class="lt">${label}${l.cost ? ` · <b>${fmt$(l.cost)}</b>` : ''}${sub ? `<small>${sub}</small>` : ''}${l.note && l.from ? `<small>${l.note}</small>` : ''}</span>
    <span class="lm">${fmtMin(l.secs)}</span></li>`;
}
type CarInfo = { kind: number; dur: number; cost: number; n: number; observed: boolean; miles: number };
function renderTip(ex: Explain | null, alts: (Explain | null)[], cars: CarInfo[] = []) {
  if (!ex || hoverTile !== ex.tile) return;
  if (budgetMode === 'money') return renderMoneyTip(ex, alts, cars);
  const fastest = alts[0];
  const seen = new Set<number>([ex.kind, K_UBER, K_TAXI]);
  if (fastest) seen.add(fastest.kind);
  const others: { kind: number; dur: number; cost: number; note?: string }[] = [
    ...cars.map((c) => ({ ...c, note: c.observed ? `${c.n.toLocaleString()} real trips` : 'estimate' })),
    ...(alts.slice(1).filter((o) => o && !seen.has(o.kind)) as Explain[]),
  ];
  tip.innerHTML = `
    ${Object.keys(params.fareOverrides ?? {}).length ? '<span class="hypo">Hypothetical fares</span>' : ''}
    <div class="zone">${ex.zone || 'Destination'}</div>
    <div class="sec"><div class="lab">Cheapest within ${T} min</div>
      <div class="big"><b>${fmt$(ex.cost)}</b><span>${fmtMin(ex.dur)} · ${KIND_NAME[ex.kind]}</span></div>
      <ul class="legs">${ex.legs.filter((l) => l.secs >= 30 || l.mode !== 'walk').map(legHTML).join('')}</ul>
    </div>
    ${fastest && fastest.dur < ex.dur - 59 ? `<div class="sec"><div class="lab">Fastest</div>
      <div class="big"><b>${fmtMin(fastest.dur)}</b><span>${fmt$(fastest.cost)} · ${KIND_NAME[fastest.kind]}</span></div>
      <ul class="legs">${fastest.legs.filter((l) => l.secs >= 30 || l.mode !== 'walk').map(legHTML).join('')}</ul></div>` : ''}
    ${others.length ? `<div class="sec alts"><div class="lab">Other ways</div>${others
      .map((o) => `<div><span>${KIND_NAME[o.kind]}${o.note ? ` <small style="color:var(--muted)">${o.note}</small>` : ''}${o.dur > T * 60 ? ` <small style="color:#A51C30">over ${T} min</small>` : ''}</span><b>${fmt$(o.cost)} · ${fmtMin(o.dur)}</b></div>`).join('')}</div>` : ''}`;
  tip.hidden = false;
  positionTip();
}
/** Money mode: headline = fastest trip within budget; then one-line comparisons (cheapest, fastest at any price, bikes, cars). */
function renderMoneyTip(ex: Explain, alts: (Explain | null)[], cars: CarInfo[]) {
  const cheapest = alts[alts.length - 1], fastest = alts[0];
  const rows: { label: string; dur: number; cost: number; note?: string }[] = [];
  if (cheapest && cheapest.cost < ex.cost - 0.004) rows.push({ label: `Cheapest · ${KIND_NAME[cheapest.kind]}`, dur: cheapest.dur, cost: cheapest.cost });
  if (fastest && fastest.dur < ex.dur - 59) rows.push({ label: `Fastest · ${KIND_NAME[fastest.kind]}`, dur: fastest.dur, cost: fastest.cost });
  const shown = new Set<number>([ex.kind, K_UBER, K_TAXI]);
  for (const a of alts.slice(1, -1)) if (a && !shown.has(a.kind)) { shown.add(a.kind); rows.push({ label: KIND_NAME[a.kind], dur: a.dur, cost: a.cost }); }
  for (const c of cars) rows.push({ label: KIND_NAME[c.kind], dur: c.dur, cost: c.cost, note: c.observed ? `${c.n.toLocaleString()} real trips` : 'estimate' });
  tip.innerHTML = `
    ${Object.keys(params.fareOverrides ?? {}).length ? '<span class="hypo">Hypothetical fares</span>' : ''}
    <div class="zone">${ex.zone || 'Destination'}</div>
    <div class="sec"><div class="lab">Fastest for $${M.toFixed(2)} or less</div>
      <div class="big"><b>${fmtMin(ex.dur)}</b><span>${fmt$(ex.cost)} · ${KIND_NAME[ex.kind]}</span></div>
      <ul class="legs">${ex.legs.filter((l) => l.secs >= 30 || l.mode !== 'walk').map(legHTML).join('')}</ul>
    </div>
    ${rows.length ? `<div class="sec alts"><div class="lab">Compare</div>${rows.map((o) => {
      const over = o.cost > M + 1e-9;
      return `<div><span>${o.label}${o.note ? ` <small style="color:var(--muted)">${o.note}</small>` : ''}${over ? ` <small style="color:#A51C30">over budget</small>` : ''}</span><b>${fmtMin(o.dur)} · ${fmt$(o.cost)}</b></div>`;
    }).join('')}</div>` : ''}`;
  tip.hidden = false;
  positionTip();
}
map.getCanvas().addEventListener('mouseleave', () => { tip.hidden = true; hoverTile = -1; });

// ------------------------------------------------------------------ controls
const minsEl = $<HTMLInputElement>('mins');
function setT(v: number) {
  T = Math.max(5, Math.min(120, Math.round(v)));
  minsEl.value = String(T);
  if (!result) return;
  refresh();
}
function setM(v: number) {
  M = Math.max(0, Math.min(100, Math.round(v * 4) / 4));
  minsEl.value = M.toFixed(2);
  if (!result) return;
  // a lower budget is a subset of the last search; a higher one needs a new search (journeys over the old cap were pruned)
  refresh();
}
minsEl.addEventListener('change', () => (budgetMode === 'time' ? setT(+minsEl.value) : setM(+minsEl.value)));
// stepper: ±5 min in time mode, ±$1 in money mode
document.querySelectorAll<HTMLButtonElement>('.stepper button').forEach((b) => b.addEventListener('click', () =>
  budgetMode === 'time' ? setT(T + 5 * +b.dataset.step!) : setM(M + +b.dataset.step!)));

// Time / Money budget switch
const swBtns = document.querySelectorAll<HTMLButtonElement>('.budget-sw button');
swBtns.forEach((b) => b.addEventListener('click', () => {
  const mode = b.dataset.b as 'time' | 'money';
  if (mode === budgetMode) return;
  budgetMode = mode;
  swBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.b === mode)));
  const money = mode === 'money';
  $('budgetPre').hidden = !money; $('budgetUnit').textContent = money ? 'max' : 'min';
  minsEl.classList.toggle('money', money);
  Object.assign(minsEl, money ? { min: '0', max: '100', step: '0.25' } : { min: '5', max: '120', step: '5' });
  minsEl.value = money ? M.toFixed(2) : String(T);
  sim.refresh(); syncThreshold();
  hoverTile = -1; tip.hidden = true;
  if (!result) return;
  // re-search if the horizon grew, or when leaving money mode (that search dropped journeys over the budget)
  if (needsQuery()) runQuery(); else recompute(true);
}));

const bindNum = (id: string, key: keyof Params) => $<HTMLInputElement>(id).addEventListener('change', (e) => { (params as any)[key] = Math.max(0, +(e.target as HTMLInputElement).value || 0); runQuery(); });
bindNum('tpw', 'tripsPerWeek'); bindNum('tipUber', 'tipUber'); bindNum('tipTaxi', 'tipTaxi'); bindNum('other', 'otherRides');
$<HTMLSelectElement>('day').addEventListener('change', (e) => { params.day = (e.target as HTMLSelectElement).value as any; runQuery(); });
$<HTMLInputElement>('time').addEventListener('change', (e) => {
  const [h, m] = (e.target as HTMLInputElement).value.split(':').map(Number); params.depSec = h * 3600 + m * 60; runQuery();
});
$<HTMLSelectElement>('member').addEventListener('change', (e) => {
  params.membership = (e.target as HTMLSelectElement).value as any;
  $('memberHint').textContent = { nonmember: 'No membership: $4.99 unlock per ride', annual: 'No unlock fee; $239/yr split across your weekly rides', member: 'No unlock fee; membership already paid' }[params.membership];
  runQuery();
});
$<HTMLInputElement>('docks').addEventListener('change', (e) => { showDocks = (e.target as HTMLInputElement).checked; render(); });
$<HTMLInputElement>('three').addEventListener('change', (e) => {
  show3D = (e.target as HTMLInputElement).checked;
  map.easeTo({ pitch: show3D ? 55 : 0, bearing: show3D ? -20 : 0, duration: 900 });
  version++; render();
});
$('advToggle').addEventListener('click', () => {
  const p = $('adv'); p.classList.toggle('collapsed');
  $('advToggle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed')));
});

const modesEl = $('modes');
modesEl.innerHTML = MODES.map((m) => `<button class="chip" type="button" data-k="${m.key}" aria-pressed="true">
  <span class="b" style="--c:${m.c};--t:${m.t ?? '#fff'}">${m.b}</span>${m.label}</button>`).join('');
modesEl.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.k as ModeKey;
  params.modes[k] = !params.modes[k];
  b.setAttribute('aria-pressed', String(params.modes[k]));
  runQuery();
}));

// keep K_* imports referenced for tree-shaking clarity
void K_WALK;

setupWhatif(params, () => runQuery());
setupAbout();
// Threshold pane (right column, above Advanced): the opposite limit to the header budget.
// Time mode -> max $ per trip (blank = any price); money mode -> longest trip in minutes. Used by the map and the simulation.
const thrPanel = document.createElement('aside');
thrPanel.id = 'thrPanel'; thrPanel.className = 'panel';
thrPanel.innerHTML = `<label class="kicker" for="thrIn">Threshold</label>
  <div class="thr-hero"><em id="thrPre">$</em><input id="thrIn" type="number" inputmode="decimal" /><span><em id="thrPost">min</em> <small id="thrHint"></small></span></div>`;
document.getElementById('rightcol')?.insertBefore(thrPanel, $('adv'));
const thrIn = $<HTMLInputElement>('thrIn');
function syncThreshold() {
  const money = budgetMode === 'money';
  $('thrHint').textContent = money ? 'longest trip' : 'max cost per trip';
  $('thrPre').hidden = money; $('thrPost').hidden = !money;
  Object.assign(thrIn, money ? { min: '5', max: '120', step: '5', placeholder: '' } : { min: '0', max: '100', step: '0.25', placeholder: 'any' });
  thrIn.value = money ? String(moneyH) : isFinite(timeCap) ? String(timeCap) : '';
  fitThr();
}
// size the big number to its content so the unit/hint sit right after it
const thrMeasure = document.createElement('canvas').getContext('2d')!;
const fitThr = () => {
  $('thrPre').hidden = budgetMode === 'money' || thrIn.value.trim() === '';   // "any", not "$any"
  thrMeasure.font = getComputedStyle(thrIn).font;
  thrIn.style.width = `${Math.ceil(thrMeasure.measureText(thrIn.value || thrIn.placeholder || '0').width) + 6}px`;
};
thrIn.addEventListener('input', fitThr);
thrIn.addEventListener('change', () => {
  const v = thrIn.value.trim();
  if (budgetMode === 'money') moneyH = Math.max(5, Math.min(120, Math.round(+v || 60)));
  else timeCap = v === '' ? Infinity : Math.max(0, +v || 0);
  syncThreshold(); sim.refresh(); refresh();
});
syncThreshold();

const sim = setupSim({ params, getBudget: () => ({ mode: budgetMode, T, M, moneyH, timeCap }), map, h3ids: () => h3ids, beforeId: 'highway_path',
  // body.sim-on hides the pin-view controls (area box, Threshold, Advanced, What if?, mode bar) while the heatmap is shown
  setSim: (active, layers) => { simActive = active; simLayers = layers; tip.hidden = true; document.body.classList.toggle('sim-on', active); render(); } });

// ------------------------------------------------------------------ tip bubble: a suggested simulation to try
// Slides in ~3 s after load, closes itself after ~12 s (paused while hovered). "Try it" applies the settings and runs it.
const bubble = document.createElement('aside');
bubble.id = 'tipBubble'; bubble.setAttribute('role', 'status');
bubble.innerHTML = `<button type="button" class="tb-x" aria-label="Close">×</button>
  <b>Try this simulation</b>
  <p>Where in NYC can you get furthest in <strong>20 minutes</strong> for <strong>under $5</strong>?</p>
  <button type="button" class="tb-go">Run it</button>`;
document.body.appendChild(bubble);
let bubbleTimer = 0;
const closeBubble = () => { bubble.classList.remove('show'); clearTimeout(bubbleTimer); };
const armClose = () => { clearTimeout(bubbleTimer); bubbleTimer = window.setTimeout(closeBubble, 12000); };
bubble.querySelector('.tb-x')!.addEventListener('click', closeBubble);
bubble.addEventListener('mouseenter', () => clearTimeout(bubbleTimer));
bubble.addEventListener('mouseleave', armClose);
bubble.querySelector('.tb-go')!.addEventListener('click', () => {
  closeBubble();
  if (budgetMode !== 'time') document.querySelector<HTMLButtonElement>('.budget-sw button[data-b=time]')!.click();
  setT(20);
  timeCap = 5; syncThreshold(); sim.refresh(); refresh();
  const sp = document.getElementById('simPanel');
  if (sp?.classList.contains('collapsed')) sp.querySelector<HTMLButtonElement>('.panel-head')!.click();
  document.getElementById('simRun')!.click();
});
window.setTimeout(() => { if (!simActive) { bubble.classList.add('show'); armClose(); } }, 3000);
