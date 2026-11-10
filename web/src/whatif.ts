// "What if?" fare sliders, in their own panel (left column, under Advanced): override fares and re-run the search.
import './whatif.css';
import type { Params } from './types';

export const WHATIF: { k: string; label: string; base: number; min: number; max: number; step: number; unit?: string }[] = [
  { k: 'mta', label: 'Subway / bus fare', base: 3.0, min: 0, max: 6, step: 0.25 },
  { k: 'cap', label: 'Weekly fare cap', base: 35, min: 0, max: 70, step: 1 },
  { k: 'express', label: 'Express bus fare', base: 7.25, min: 0, max: 12, step: 0.25 },
  { k: 'ferry', label: 'NYC Ferry fare', base: 5, min: 0, max: 10, step: 0.25 },
  { k: 'cbClassic', label: 'Citi Bike classic ride / unlock price', base: 4.99, min: 0, max: 10, step: 0.01 },
  { k: 'cbUnlock', label: 'Citi Bike e-bike unlock fee', base: 4.99, min: 0, max: 10, step: 0.01 },
  { k: 'cbNonPerMin', label: 'Citi Bike per minute, no membership', base: 0.41, min: 0, max: 1, step: 0.01 },
  { k: 'cbMemPerMin', label: 'Citi Bike per minute, member', base: 0.27, min: 0, max: 1, step: 0.01 },
  { k: 'cbAnnual', label: 'Citi Bike annual membership', base: 239, min: 0, max: 500, step: 1 },
  { k: 'ebikeCap', label: 'Citi Bike e-bike speed cap', base: 15, min: 8, max: 28, step: 1, unit: 'mph' },
];

export function setupWhatif(params: Params, rerun: () => void) {
  // left column: What if? (collapsed by default) then Simulation (open by default)
  const col = document.createElement('div');
  col.id = 'leftcol';
  document.body.appendChild(col);
  // right column: the area box, then Advanced underneath it
  const right = document.createElement('div');
  right.id = 'rightcol';
  document.body.appendChild(right);
  const side = document.getElementById('side'), adv = document.getElementById('adv');
  if (side) right.appendChild(side);
  if (adv) right.appendChild(adv);

  const panel = document.createElement('aside');
  panel.id = 'whatifPanel';
  panel.className = 'panel collapsed';
  panel.innerHTML = `<button class="panel-head" type="button" aria-expanded="false"><span>What if?</span><i></i></button>
    <div class="panel-body">
      <p class="fine" style="margin:0">Change prices and watch the map redraw. Real prices are the defaults.</p>
      <div class="whatif">${WHATIF.map((w) => `<label class="wi"><span>${w.label}<b data-v="${w.k}">${fmt(w, w.base)}</b></span>
        <input type="range" data-k="${w.k}" min="${w.min}" max="${w.max}" step="${w.step}" value="${w.base}" /></label>`).join('')}</div>
      <label class="wi-check"><input type="checkbox" data-c="cbNoFree" /> <span><b>Citi Bike: no free minutes</b><small>Unlock fees stay; every minute is charged at the per-minute rates above (no 30 min / 45 min included).</small></span></label>
      <button type="button" class="wi-reset">Reset to real prices</button>
    </div>`;
  col.appendChild(panel);
  const head = panel.querySelector<HTMLButtonElement>('.panel-head')!;
  head.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!panel.classList.contains('collapsed')));
  });

  const badge = document.createElement('span');
  badge.className = 'whatif-badge'; badge.textContent = 'Hypothetical fares'; badge.hidden = true;
  document.getElementById('side')?.prepend(badge);

  const inputs = [...panel.querySelectorAll<HTMLInputElement>('input[type=range]')];
  const spec = (el: HTMLInputElement) => WHATIF.find((x) => x.k === el.dataset.k)!;
  const label = (k: string) => panel.querySelector<HTMLElement>(`[data-v="${k}"]`)!;
  const apply = () => {
    const o: Record<string, number> = {};
    for (const el of inputs) {
      const w = spec(el);
      if (Math.abs(+el.value - w.base) > 0.001) o[w.k] = +el.value;
    }
    const lin = panel.querySelector<HTMLInputElement>('[data-c="cbNoFree"]')!;
    if (lin.checked) o.cbNoFree = 1;
    params.fareOverrides = o;
    badge.hidden = Object.keys(o).length === 0;
    rerun();
  };
  for (const el of inputs) {
    el.value = String(spec(el).base);  // make sure every slider starts exactly at the real price
    el.addEventListener('input', () => { label(spec(el).k).textContent = fmt(spec(el), +el.value); });
    el.addEventListener('change', apply);
  }
  panel.querySelector<HTMLInputElement>('[data-c="cbNoFree"]')!.addEventListener('change', apply);
  panel.querySelector<HTMLButtonElement>('.wi-reset')!.addEventListener('click', () => {
    for (const el of inputs) { const w = spec(el); el.value = String(w.base); label(w.k).textContent = fmt(w, w.base); }
    panel.querySelector<HTMLInputElement>('[data-c="cbNoFree"]')!.checked = false;
    apply();
  });
}

function fmt(w: { step: number; unit?: string }, v: number) { return w.unit ? `${v} ${w.unit}` : `$${v.toFixed(w.step < 1 ? 2 : 0)}`; }
