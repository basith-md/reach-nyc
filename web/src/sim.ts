// Connectivity simulation: many origins across the city, each run with the UI's exact settings,
// scored by EFFECTIVE area reachable: area reachable within the time and cost limits, scaled up by how little usable land
// surrounds the point (area ÷ land fraction of a straight-line circle, R = 20 km/h x time limit), interpolated into a heatmap.
import './sim.css';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Map as MLMap } from 'maplibre-gl';
import type { Params } from './types';

interface Ctx {
  params: Params;                       // live UI settings (snapshotted at Run)
  getBudget: () => { mode: 'time' | 'money'; T: number; M: number; moneyH: number; timeCap: number };   // live header budget + the other-axis caps
  map: MLMap;
  h3ids: () => string[];
  setSim: (active: boolean, layers: any[]) => void;
  beforeId: string;
}

const RES = {
  low: { label: 'Low', km: 2.1 },
  med: { label: 'Medium', km: 1.13 },
  high: { label: 'High', km: 0.78 },
} as const;
type ResKey = keyof typeof RES;

// 10 steps with a wide hue sweep (pale yellow -> green -> teal -> blue -> purple -> magenta) so every neighbouring band is distinct
// diverging around the user's threshold: 5 reds below (dark = worst), 5 greens above (dark = best)
const HEAT = ['#7F0E1E', '#B4232C', '#E04A3A', '#F38A6B', '#FBC3A8', '#C7E9B4', '#8CD08A', '#4DB06A', '#1F8A4C', '#0B5E33'];
const rgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const HEAT_RGB = HEAT.map(rgb);

// Effective area reachable (shared with the pin view):
//   R = average straight-line distance from the point to everywhere it can reach
//   land fraction = NYC land within R of the point / (pi R^2)
//   effective area = area reachable / land fraction  (fraction floored at 25%, so edge points get at most a 4x boost)
export const MIN_LAND_FRAC = 0.25;
export const landFrac = (landKm2: number, Rkm: number) =>
  Rkm > 0 ? Math.max(MIN_LAND_FRAC, Math.min(1, landKm2 / (Math.PI * Rkm * Rkm))) : 1;

export function setupSim(ctx: Ctx) {
  let lat: Float32Array | null = null, lng: Float32Array | null = null;
  const llReady = fetch('/data/tiles_ll.bin').then((r) => r.arrayBuffer()).then((b) => {
    const f = new Float32Array(b); const n = f.length / 2;
    lat = new Float32Array(n); lng = new Float32Array(n);
    for (let i = 0; i < n; i++) { lat[i] = f[2 * i]; lng[i] = f[2 * i + 1]; }
  });

  // ---------------- panel (left column, under What if?)
  const panel = document.createElement('aside');
  panel.id = 'simPanel'; panel.className = 'panel';
  panel.innerHTML = `<button class="panel-head" type="button" aria-expanded="true"><span>Simulation</span><i></i></button>
    <div class="panel-body">
      <p class="fine" style="margin:0">Get a distribution map of the whole city. We drop pins everywhere, measure how much of NYC each spot can reach with your current settings, and colour the result so transit deserts (red) and well-connected areas (green) stand out.</p>
      <div class="sim-res" role="radiogroup" aria-label="Resolution">
        ${(Object.keys(RES) as ResKey[]).map((k) => `<label><input type="radio" name="simRes" value="${k}" ${k === 'med' ? 'checked' : ''}/> <span>${RES[k].label}<small data-n="${k}">…</small></span></label>`).join('')}
      </div>
      <div class="sim-uses" id="simUses"></div>
      <div class="sim-actions"><button type="button" id="simRun" class="sim-primary">Run simulation</button><button type="button" id="simCancel" hidden>Cancel</button></div>
      <div class="sim-progress" hidden><div class="bar"><i></i></div><span id="simStatus"></span></div>
      <div class="sim-done" hidden>
        <div class="sim-res" role="radiogroup" aria-label="Metric">
          <label><input type="radio" name="simMetric" value="eff" checked /> <span>Effective area<small>scaled up where water or the city edge leaves less land nearby</small></span></label>
          <label><input type="radio" name="simMetric" value="area" /> <span>Area<small>km² reachable as is</small></span></label>
        </div>
        <div class="sim-range">
          <span>Colour range<small>drag the ends in to see more difference in the middle</small></span>
          <div class="dual" style="--grad:linear-gradient(to right, ${HEAT.join(', ')})">
            <input type="range" id="simLo" min="0" max="50" step="1" value="0" aria-label="Darkest red starts at percentile" />
            <input type="range" id="simHi" min="50" max="100" step="1" value="100" aria-label="Darkest green starts at percentile" />
          </div>
        </div>
        <ol class="legend" id="simLegend"></ol>
        <p class="fine sim-note" id="simNote"></p>
        <div class="sim-actions"><button type="button" id="simPng">Download map (PNG)</button><button type="button" id="simCsv">Download data (CSV)</button></div>
      </div>
    </div>`;
  (document.getElementById('leftcol') ?? document.body).appendChild(panel);
  const $ = <T extends HTMLElement>(sel: string) => panel.querySelector(sel) as T;
  const head = $('.panel-head') as HTMLButtonElement;
  head.addEventListener('click', () => { panel.classList.toggle('collapsed'); head.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed'))); refreshInfo(); });

  const cores = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  let lastMsPerOrigin = 1800;

  function originsFor(k: ResKey): number[] {
    if (!lat || !lng) return [];
    const s = RES[k].km, kx = 84.3, ky = 111.32;           // km per degree at NYC latitude
    const best = new Map<string, { t: number; d: number }>();
    for (let t = 0; t < lat.length; t++) {
      const x = lng[t] * kx / s, y = lat[t] * ky / s;
      const gx = Math.floor(x), gy = Math.floor(y), key = `${gx},${gy}`;
      const d = (x - gx - 0.5) ** 2 + (y - gy - 0.5) ** 2;   // distance to bucket centre
      const b = best.get(key);
      if (!b || d < b.d) best.set(key, { t, d });
    }
    return [...best.values()].map((v) => v.t);
  }
  function refreshInfo() {
    llReady.then(() => {
      for (const k of Object.keys(RES) as ResKey[]) {
        const n = originsFor(k).length;
        const sec = n * lastMsPerOrigin / 1000 / cores;
        $(`[data-n="${k}"]`).textContent = `${n} points · ~${sec < 90 ? Math.ceil(sec / 10) * 10 + ' s' : Math.ceil(sec / 60) + ' min'}`;
      }
    });
    const b = ctx.getBudget();
    const p = ctx.params, hh = String(Math.floor(p.depSec / 3600)).padStart(2, '0'), mm = String(Math.floor(p.depSec % 3600 / 60)).padStart(2, '0');
    const off = Object.entries(p.modes).filter(([, v]) => !v).map(([k]) => k);
    $('#simUses').textContent = `Uses: ${b.mode === 'time' ? `${b.T} min, ${isFinite(b.timeCap) ? `up to $${b.timeCap.toFixed(2)}` : 'any price'}` : `$${b.M.toFixed(2)}, trips up to ${b.moneyH} min`} · ${({ wkd: 'Weekday', sat: 'Saturday', sun: 'Sunday' })[p.day]} ${hh}:${mm} · ${p.tripsPerWeek} trip${p.tripsPerWeek === 1 ? "" : "s"}/wk` +
      `${off.length ? ` · off: ${off.join(', ')}` : ''}${Object.keys(p.fareOverrides ?? {}).length ? ' · hypothetical fares' : ''}`;
  }
  panel.addEventListener('change', refreshInfo);
  refreshInfo();   // panel starts open, so fill in point counts and the "Uses" line now

  // ---------------- run
  let workers: Worker[] = [];
  let cancelled = false;
  // eff = effective area reachable = km2 / landFrac (see landFrac above; R = each point's average reach distance).
  // km2 (raw area reachable), land (km² of NYC land within R) and rad (R, km) are kept for the tooltip and CSV.
  let result: { origins: number[]; km2: Float32Array; eff: Float32Array; land: Float32Array; rad: Float32Array; snap: Params; T: number; D: number; res: ResKey } | null = null;
  const fmt = (v: number) => v.toFixed(1);
  const pctf = (v: number) => `${Math.round(v)}%`;
  // which metric is mapped: effective area (default) or raw area reachable; switching recolours without a re-run
  type Metric = 'eff' | 'area';
  const metric = (): Metric => (panel.querySelector<HTMLInputElement>('input[name=simMetric]:checked')?.value ?? 'eff') as Metric;
  const vals = () => (metric() === 'eff' ? result!.eff : result!.km2);
  const mName = () => (metric() === 'eff' ? 'Effective area' : 'Area');
  const rule = (r: { T: number; D: number }) => isFinite(r.D) ? `for $${r.D.toFixed(2)} or less (trips up to ${r.T} min)` : `within ${r.T} min, any price`;
  const tag = (r: { T: number; D: number }) => isFinite(r.D) ? `$${r.D}` : `${r.T}min`;

  // exit button above the mode chips + hover tooltip, both only while the simulation view is on
  const exitBar = document.createElement('button');
  exitBar.id = 'simExitBar'; exitBar.type = 'button'; exitBar.textContent = 'Exit simulation view'; exitBar.hidden = true;
  document.body.appendChild(exitBar);
  const tip = document.createElement('div');
  tip.className = 'tip sim-tip'; tip.hidden = true;
  document.body.appendChild(tip);
  const exitSim = () => { exitBar.hidden = true; tip.hidden = true; ctx.setSim(false, []); };
  exitBar.addEventListener('click', exitSim);
  function simHover(info: any) {
    const t = info.index ?? -1;
    if (t < 0 || !result || !lat || !lng || info.x === undefined) { tip.hidden = true; return; }
    const kx = 84.3, ky = 111.32, x = lng[t] * kx, y = lat[t] * ky;
    let ni = 0, nd = Infinity;
    result.origins.forEach((o, i) => { const d = (lng![o] * kx - x) ** 2 + (lat![o] * ky - y) ** 2; if (d < nd) { nd = d; ni = i; } });
    const mv = vals(), v = tileVal[t], better = Math.round(100 * Array.from(mv).filter((a) => a <= v).length / mv.length);
    const R = result.rad[ni];
    tip.innerHTML = `<div class="zone">Simulated reach</div>
      <div class="sec"><div class="lab">From around here</div>
        <div class="big"><b style="white-space:nowrap">${fmt(v)} km²</b><span>${metric() === 'eff' ? 'effective area' : 'area'}</span></div>
        <div style="color:var(--ink-2)">reachable ${rule(result)}</div>
        <div style="color:var(--ink-2)">Better connected than ${better}% of points</div></div>
      <div class="sec alts"><div><span>Nearest simulated pin (${Math.sqrt(nd).toFixed(1)} km)</span><b>${fmt(mv[ni])} km²</b></div>
        <div><span>· effective area</span><b>${fmt(result.eff[ni])} km²</b></div>
        <div><span>· actual area reached</span><b>${fmt(result.km2[ni])} km²</b></div>
        <div><span>· land within ${fmt(R)} km (avg reach)</span><b>${pctf(100 * landFrac(result.land[ni], R))}</b></div>
        <div><span>City median</span><b>${fmt(Array.from(mv).sort((a, b) => a - b)[mv.length >> 1])} km²</b></div></div>`;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let px = info.x + 18, py = info.y + 18;
    if (px + w > innerWidth - 8) px = info.x - w - 18;
    if (py + h > innerHeight - 8) py = Math.max(8, innerHeight - h - 8);
    tip.style.left = `${px}px`; tip.style.top = `${py}px`;
  }
  ctx.map.getCanvas().addEventListener('mouseleave', () => { tip.hidden = true; });

  $('#simRun').addEventListener('click', run);
  $('#simCancel').addEventListener('click', () => { cancelled = true; stop(); setStatus('Cancelled.'); ui('idle'); });
  panel.querySelectorAll('input[name=simMetric]').forEach((el) => el.addEventListener('change', () => { if (result) show(); }));
  $('#simLo').addEventListener('input', () => paint());
  $('#simHi').addEventListener('input', () => paint());
  $('#simPng').addEventListener('click', downloadPng);
  $('#simCsv').addEventListener('click', downloadCsv);

  function ui(state: 'idle' | 'running' | 'done') {
    ($('#simRun') as HTMLButtonElement).disabled = state === 'running';
    $('#simCancel').hidden = state !== 'running';
    $('.sim-progress').hidden = state === 'idle' && !$('#simStatus').textContent;
    $('.sim-done').hidden = state !== 'done';
  }
  const setStatus = (s: string) => { $('#simStatus').textContent = s; $('.sim-progress').hidden = false; };
  const setBar = (f: number) => { ($('.sim-progress .bar i') as HTMLElement).style.width = `${(f * 100).toFixed(1)}%`; };
  function stop() { workers.forEach((w) => w.terminate()); workers = []; }

  async function run() {
    await llReady;
    const resKey = (panel.querySelector<HTMLInputElement>('input[name=simRes]:checked')!.value) as ResKey;
    refreshInfo();
    // same rule as the map's right-hand box: time mode = within T min, up to the optional $ cap; money mode = for <= $M, trips up to moneyH min
    const b = ctx.getBudget();
    const T = b.mode === 'time' ? b.T : b.moneyH;
    const D = b.mode === 'time' ? b.timeCap : b.M;
    const snap: Params = structuredClone(ctx.params);      // every UI setting, frozen for this run
    snap.horizonMin = Math.max(T, 15);
    snap.maxCost = D;                                      // only area within $D counts, so prune pricier journeys
    const origins = originsFor(resKey);
    const km2 = new Float32Array(origins.length).fill(NaN);
    const eff = new Float32Array(origins.length).fill(NaN), land = new Float32Array(origins.length).fill(NaN), rad = new Float32Array(origins.length).fill(NaN);
    cancelled = false; stop(); ui('running'); setBar(0);
    setStatus(`Starting ${cores} parallel workers…`);
    const t0 = performance.now();
    let next = 0, done = 0;
    await new Promise<void>((resolve) => {
      const feed = (w: Worker) => {
        if (cancelled) return;
        if (next >= origins.length) { if (done === origins.length) resolve(); return; }
        const i = next++;
        w.postMessage({ type: 'sim', job: i, origin: origins[i], params: snap, T, D });
      };
      for (let k = 0; k < cores; k++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { feed(w); feed(w); return; }      // keep two jobs queued per worker
          if (m.type !== 'simres' || cancelled) return;
          km2[m.job] = m.km2; land[m.job] = m.landKm2; rad[m.job] = m.radKm; eff[m.job] = m.km2 / landFrac(m.landKm2, m.radKm); done++;
          const el = performance.now() - t0, eta = el / done * (origins.length - done);
          setBar(done / origins.length);
          setStatus(`${done} / ${origins.length} points · ${Math.round(el / 1000)} s elapsed · ~${Math.ceil(eta / 1000)} s left`);
          if (done === origins.length) resolve(); else feed(w);
        };
        workers.push(w);
      }
    });
    stop();
    if (cancelled) return;
    lastMsPerOrigin = (performance.now() - t0) * cores / origins.length;
    result = { origins, km2, eff, land, rad, snap, T, D, res: resKey };
    setStatus(`Done: ${origins.length} points in ${Math.round((performance.now() - t0) / 1000)} s.`);
    show();
    ui('done');
    refreshInfo();
  }

  // ---------------- heatmap
  let tileVal = new Float32Array(0);
  let breaks: number[] = [], lo: number[] = [], hi: number[] = [];
  function show() {
    if (!result || !lat || !lng) return;
    const { origins } = result, km2 = vals();               // interpolate the selected metric
    const N = lat.length, kx = 84.3, ky = 111.32;
    const ox = origins.map((t) => lng![t] * kx), oy = origins.map((t) => lat![t] * ky);
    const R = RES[result.res].km * 1.6;                       // blend radius
    tileVal = new Float32Array(N);
    for (let t = 0; t < N; t++) {
      const x = lng[t] * kx, y = lat[t] * ky;
      let wsum = 0, vsum = 0, nearest = -1, nd = Infinity;
      for (let i = 0; i < origins.length; i++) {
        const d2 = (ox[i] - x) ** 2 + (oy[i] - y) ** 2;
        if (d2 < nd) { nd = d2; nearest = i; }
        if (d2 < R * R) { const w = 1 / Math.max(d2, 0.01); wsum += w; vsum += w * km2[i]; }
      }
      tileVal[t] = wsum > 0 ? vsum / wsum : km2[nearest];
    }
    paint();
  }

  /** Colour the interpolated values. Cheap, so the colour-range slider can call it while dragging. */
  let paintVer = 0;
  function paint() {
    if (!result || !lat || !lng) return;
    const { origins } = result, km2 = vals();               // colour by the selected metric
    const N = lat.length;
    // pivot at the city median; the slider's two handles set where the darkest red / green start (percentiles of the points),
    // so pulling them in clips the extremes and spreads the 10 colours over the middle
    const sorted = Array.from(km2).sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.round(p / 100 * (sorted.length - 1))];
    const mn = sorted[0], mx = sorted[sorted.length - 1];
    const thr = Math.min(Math.max(q(50), mn + 1e-3), mx - 1e-3);
    const cLo = Math.min(q(+($('#simLo') as HTMLInputElement).value), thr - 1e-3);
    const cHi = Math.max(q(+($('#simHi') as HTMLInputElement).value), thr + 1e-3);
    const lin = (a: number, b: number) => [1, 2, 3, 4].map((k) => a + (b - a) * k / 5);
    breaks = [...lin(cLo, thr), thr, ...lin(thr, cHi)];
    lo = [mn, ...breaks]; hi = [...breaks, mx];
    const bin = (v: number) => { let i = 0; while (i < breaks.length && v > breaks[i]) i++; return i; };
    paintVer++;
    const ids = ctx.h3ids();
    const data = Array.from({ length: N }, (_, i) => i);
    const layers = [
      new H3HexagonLayer({
        id: 'sim-heat', data, getHexagon: (i: number) => ids[i], highPrecision: false, coverage: 1, stroked: false,
        getFillColor: (i: number) => [...HEAT_RGB[bin(tileVal[i])], 235] as any, beforeId: ctx.beforeId,
        pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 90], onHover: simHover,
        updateTriggers: { getFillColor: paintVer },
      } as any),
      new ScatterplotLayer({
        id: 'sim-dots', data: origins.map((t, i) => ({ p: [lng![t], lat![t]], v: km2[i] })), getPosition: (d: any) => d.p,
        getRadius: 3, radiusUnits: 'pixels', getFillColor: [17, 17, 17, 230], stroked: true, getLineColor: [255, 255, 255, 255],
        lineWidthUnits: 'pixels', getLineWidth: 1, beforeId: ctx.beforeId,
      } as any),
    ];
    ctx.setSim(true, layers);
    exitBar.hidden = false;
    const nGood = Array.from(km2).filter((v) => v >= thr).length;
    $('#simLegend').innerHTML = `<li class="lh"><b>${mName()}</b><span></span><span>km²</span></li>` +
      HEAT.map((c, i) => `<li><span class="sw" style="--c:${c}"></span><span>${fmt(lo[i])}–${fmt(hi[i])}</span><span></span></li>`).reverse().join('');
    $('#simNote').textContent = (metric() === 'eff'
      ? 'Area reachable, scaled up where water or the city edge leaves less land within each point\'s average reach distance (as if it were all land). '
      : 'Area reachable as is (no adjustment for water or the city edge). ') +
      `Green is above the city median of ${fmt(thr)} km², red is below. ${nGood} of ${km2.length} points are green.`;
  }

  // ---------------- downloads
  function title() {
    const r = result!, p = r.snap, hh = String(Math.floor(p.depSec / 3600)).padStart(2, '0'), mm = String(Math.floor(p.depSec % 3600 / 60)).padStart(2, '0');
    return {
      main: `${mName()} reachable (km²) · ${rule(r)}`,
      sub: `${({ wkd: 'Weekday', sat: 'Saturday', sun: 'Sunday' })[p.day]} ${hh}:${mm} · ${p.tripsPerWeek} trip${p.tripsPerWeek === 1 ? "" : "s"}/week · ${r.origins.length} points (${RES[r.res].label})` +
        `${Object.keys(p.fareOverrides ?? {}).length ? ' · hypothetical fares' : ''}`,
    };
  }
  let border: number[][][] = [];   // NYC outer rings (lng, lat) for the PNG mask
  fetch('/data/nyc_boundary.geojson').then((r) => r.json()).then((gj) => { border = gj.features[0].geometry.coordinates; }).catch(() => {});
  function downloadPng() {
    if (!result || !lat || !lng) return;
    const map = ctx.map;
    // city extent from the land tiles
    let w = Infinity, e = -Infinity, so = Infinity, no = -Infinity;
    for (let i = 0; i < lat.length; i++) { if (lng[i] < w) w = lng[i]; if (lng[i] > e) e = lng[i]; if (lat[i] < so) so = lat[i]; if (lat[i] > no) no = lat[i]; }
    const saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    map.fitBounds([[w, so], [e, no]], { padding: 24, bearing: 0, pitch: 0, duration: 0 });
    // wait until basemap tiles for the new view are loaded, then capture inside a render (the GL buffer is only valid there)
    map.once('idle', () => {
      map.once('render', () => {
        const src = map.getCanvas(), s = src.width / src.clientWidth;
        const pad = 12;
        const a = map.project([w, no]), b = map.project([e, so]);
        const cx = Math.max(0, Math.floor((a.x - pad) * s)), cy = Math.max(0, Math.floor((a.y - pad) * s));
        const cw = Math.min(src.width, Math.ceil((b.x + pad) * s)) - cx, ch = Math.min(src.height, Math.ceil((b.y + pad) * s)) - cy;
        // layout: title bar on top, cropped city map, legend column on the right, footer strip
        const top = 74 * s, side = 250 * s, foot = 26 * s;
        const c = document.createElement('canvas');
        c.width = cw + side; c.height = top + ch + foot;
        const g = c.getContext('2d')!;
        g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(src, cx, cy, cw, ch, 0, top, cw, ch);
        // wash out everything outside the city border (even-odd: frame minus the borough rings)
        if (border.length) {
          g.save();
          g.beginPath(); g.rect(0, top, cw, ch);
          for (const ring of border) ring.forEach(([x, y2], k) => {
            const p = map.project([x, y2]), px = p.x * s - cx, py = p.y * s - cy + top;
            if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
          });
          g.fillStyle = 'rgba(244,241,234,.88)'; g.fill('evenodd');
          g.restore();
        }
        const t = title(), F = 'Inter, Helvetica, Arial, sans-serif';
        g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, c.width, top);
        g.fillStyle = '#fff'; g.font = `800 ${24 * s}px ${F}`; g.fillText(t.main, 20 * s, 34 * s);
        g.fillStyle = '#c8c8c8'; g.font = `500 ${13 * s}px ${F}`; g.fillText(t.sub, 20 * s, 58 * s);
        // legend column
        const lx = cw + 16 * s; let y = top + 28 * s;
        g.fillStyle = '#111'; g.font = `700 ${13 * s}px ${F}`; g.fillText(`${mName()} reachable, km²`, lx, y);
        g.fillStyle = '#555'; g.font = `500 ${11 * s}px ${F}`; g.fillText(`green above the median (${fmt(breaks[4])}), red below`, lx, y + 18 * s);
        y += 34 * s;
        for (let i = HEAT.length - 1; i >= 0; i--) {           // best (green) at the top
          g.fillStyle = HEAT[i]; g.fillRect(lx, y, 16 * s, 16 * s);
          g.fillStyle = '#333'; g.font = `500 ${12 * s}px ${F}`; g.fillText(`${fmt(lo[i])} – ${fmt(hi[i])}`, lx + 24 * s, y + 13 * s);
          y += 24 * s;
        }
        g.fillStyle = '#555'; g.font = `400 ${10 * s}px ${F}`;
        g.fillText('Reach NYC · values between points are interpolated · © OpenStreetMap contributors', 20 * s, c.height - 9 * s);
        c.toBlob((bl) => bl && save(bl, `nyc-area-${tag(result!)}.png`));
        map.jumpTo(saved);                                     // back to the user's view
      });
      map.triggerRepaint();
    });
  }
  function downloadCsv() {
    if (!result || !lat || !lng) return;
    const t = title();
    const r = result;
    const rows = [`# ${t.main}`, `# ${t.sub}`, '# radius_km = average straight-line distance from the point to everywhere it can reach',
      `# effective_km2 = km2_reachable / land_fraction (land_fraction = NYC land within radius / (pi radius^2), floored at ${MIN_LAND_FRAC})`,
      'lat,lng,effective_km2,km2_reachable,radius_km,land_fraction,land_km2_in_circle'];
    r.origins.forEach((o, i) => rows.push(`${lat![o].toFixed(5)},${lng![o].toFixed(5)},${r.eff[i].toFixed(3)},` +
      `${r.km2[i].toFixed(3)},${r.rad[i].toFixed(3)},${landFrac(r.land[i], r.rad[i]).toFixed(3)},${r.land[i].toFixed(3)}`));
    save(new Blob([rows.join('\n')], { type: 'text/csv' }), `nyc-connectivity-${tag(result)}.csv`);
  }
  function save(b: Blob, name: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  return { refresh: refreshInfo };
}
