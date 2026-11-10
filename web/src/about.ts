// "How it works": methodology, assumptions, limitations and glossary (opened from the header).
import './about.css';

const HTML = `
<div class="about-card" role="dialog" aria-modal="true" aria-labelledby="aboutTitle">
  <header><h2 id="aboutTitle">How it works</h2><button type="button" class="about-close" aria-label="Close">Close</button></header>
  <nav class="about-tabs">
    <button type="button" data-t="method" aria-selected="true">Methodology</button>
    <button type="button" data-t="assume">Assumptions &amp; limits</button>
    <button type="button" data-t="gloss">Glossary</button>
    <button type="button" data-t="data">Data sources</button>
  </nav>
  <div class="about-body">

  <section data-s="method">
    <h3>The question</h3>
    <p>From the pin, how far can you get within the time budget, and what is the cheapest way to get to each place? Every hexagon is coloured by the lowest price that still gets you there in time.</p>

    <h3>1. The city as hexagons</h3>
    <p>The five boroughs are split into 46,792 hexagons about 130&nbsp;m across (H3 resolution 10, ~0.015&nbsp;km² each), on land and on walkable bridges. Neighbouring hexagons are linked only if you can walk between them on streets in OpenStreetMap, so rivers can only be crossed on bridges.</p>

    <h3>2. Walking</h3>
    <p>1.3&nbsp;m/s (about 4.7&nbsp;km/h), with each hexagon-to-hexagon step stretched by 20% for the street grid. Walking to the first stop is limited to 20&nbsp;min, from the last stop to 15&nbsp;min, and walking transfers between stops to 400&nbsp;m.</p>

    <h3>3. Transit</h3>
    <p>Subway, local and express buses, Staten Island Railway, LIRR and Metro-North inside the city, PATH (Manhattan stations), NYC Ferry and Staten Island Ferry, from the real published timetables. Routes are found with a multi-criteria RAPTOR search that keeps every trade-off between arrival time and cost (a slower but cheaper route survives next to a faster, pricier one). Up to four vehicles per trip.</p>
    <p>The search runs for four departures, 0, 15, 30 and 45 minutes after the chosen time, and keeps the best result for each place. You are assumed to leave just in time for your first vehicle, so the first wait is not counted; waits between vehicles are. Each extra boarding counts as 2 minutes when choosing between near-equal routes, but this is never added to the times shown.</p>

    <h3>4. Fares and trips per week</h3>
    <ul>
      <li><b>Subway and local bus:</b> $3.00 with one free subway↔bus or bus↔bus transfer. A walk between two subway stations that are not connected inside the system pays again. The $35 weekly OMNY cap is shared out per ride: price per ride = min($3 × rides, $35) ÷ rides, where rides = trips per week × 2 (return trip) + other weekly rides.</li>
      <li><b>Express bus:</b> $7.25 (an upgrade from a local fare if you transfer), weekly cap $67, shared out the same way.</li>
      <li><b>PATH:</b> the cheapest of $3.25 single, the 7-day pass ($42.75) or the 30-day pass ($131.50), per ride.</li>
      <li><b>NYC Ferry:</b> $5, or $3 per ride from the 10-trip pack if you ride 2+ times a week; free ferry-to-ferry transfer.</li>
      <li><b>LIRR / Metro-North in the city:</b> CityTicket, $7 at weekday peak (6–10 am, 4–8 pm), $5 otherwise.</li>
      <li><b>Staten Island Ferry:</b> free.</li>
    </ul>

    <h3>5. Citi Bike</h3>
    <p>A bike leg is walk to a dock (≤10&nbsp;min) → ride → dock → walk. Riding speeds are measured from real September 2026 Citi Bike trips, by hour of the week and bike type, along our street network. Unlocking takes 1&nbsp;min and docking 30&nbsp;s. A bike can be used at the start, the end, or between two transit rides; each bike leg is a separate ride with its own fee.</p>
    <ul>
      <li><b>No membership (default):</b> classic $4.99 per ride including 30&nbsp;min, then $0.41/min; e-bike $4.99 unlock + $0.41/min.</li>
      <li><b>Annual member:</b> no unlock fee; classic includes 45&nbsp;min, then $0.27/min; e-bike $0.27/min (capped at $5.40 for rides up to 45&nbsp;min that start or end in Manhattan). "Spread over your trips" adds $239 ÷ 52 ÷ weekly rides, once per trip.</li>
      <li><b>Dock swaps:</b> a long classic ride is split into several rides whenever that is cheaper (1&nbsp;min per swap). E-bikes are never swapped (per-minute either way). Rides are capped at 90&nbsp;min.</li>
    </ul>

    <h3>6. Uber / Lyft and taxi</h3>
    <p>Built from 58 million Uber/Lyft and 7 million yellow/green taxi trips (Jul–Sep 2026, NYC TLC). For each hour of the week a price formula (base + per mile + per minute) is fitted to all trips. Where a pair of taxi zones has at least 30 trips with consistent prices, the formula is scaled to match what riders actually paid there ("real trips" on hover); otherwise the formula alone is used ("estimate").</p>
    <p>Distance = straight line between the pickup and drop-off hexagons × the typical road detour for that zone pair (1.38 citywide). Speed = typical speed for that zone pair and hour. Tolls = typical tolls paid on that zone pair. Pickup wait = median time from request to car arrival for that zone and hour (also used for hailing a cab). Cars only stop where a car may legally stop, so trips into parks, plazas and campuses end with a walk. Prices are before tip unless a tip is set in Advanced.</p>

    <h3>7. The map</h3>
    <p>Each hexagon shows the cheapest option that arrives within the time budget. The area figures add up hexagons (0.015&nbsp;km² each) and are cumulative: "up to $6" includes everything reachable for less. Changing the time budget only recolours; changing the pin, day, time, trips per week, modes or fares re-runs the search in your browser (about 2&nbsp;s).</p>
  </section>

  <section data-s="assume" hidden>
    <h3>Assumptions</h3>
    <ul>
      <li>Schedules are a typical weekday (Tue 10 Nov 2026), Saturday (14 Nov) and Sunday (15 Nov). Before 4 am the previous service day's late-night trips are used.</li>
      <li>Everything runs on schedule: no delays, closures or crowding.</li>
      <li>You leave just in time for your first vehicle; waits for later vehicles count.</li>
      <li>The return trip is counted for caps and passes, and you make the same trip every week.</li>
      <li>Citi Bike always has a bike and a free dock where you need them.</li>
      <li>E-bike speed cap 15&nbsp;mph (today). In What if?, average e-bike speed changes with the square root of the new cap ÷ 15, because lights and traffic absorb much of the gain; an e-bike is never slower than a classic.</li>
      <li>Car prices and times are averages for the hour of the week: real surge, traffic and pickup times vary from trip to trip. Taxi hail waits are not recorded anywhere, so the Uber/Lyft pickup wait is used for cabs too.</li>
      <li>"What if?" fares change only the prices you move; everything else stays real.</li>
    </ul>
    <h3>Known limits</h3>
    <ul>
      <li>PATH uses its March 2025 timetable: the public feed has not been updated since mid-2026.</li>
      <li>LIRR/Metro-North fares are the public CityTicket prices (the MTA fare tables could not be downloaded automatically).</li>
      <li>Step-free access (elevators, stairs) is not modelled.</li>
      <li>In the middle or at the end of a trip, a bike leg starts from the fastest way to reach that stop, so a slower but cheaper combination can occasionally be missed.</li>
      <li>Uber/taxi tolls are only added on zone pairs with enough real trips.</li>
      <li>New Jersey, Westchester and Long Island are not covered yet.</li>
      <li>Hexagons are ~130&nbsp;m across: places inside one hexagon share one result.</li>
    </ul>
  </section>

  <section data-s="gloss" hidden>
    <dl>
      <dt>Time budget</dt><dd>The longest door-to-door trip you accept, in minutes.</dd>
      <dt>Trips per week</dt><dd>How often you make this journey each way. Used to share passes, caps and memberships out per ride.</dd>
      <dt>Cheapest within N min</dt><dd>The lowest price of any route that arrives within the time budget. This sets the hexagon's colour.</dd>
      <dt>Fastest</dt><dd>The quickest route at any price.</dd>
      <dt>Hexagon / tile</dt><dd>A ~130&nbsp;m cell of the map (H3 resolution 10). Every place inside it shares one result.</dd>
      <dt>Fare cap</dt><dd>OMNY stops charging after $35 of subway/bus rides in 7 days ($67 with express buses).</dd>
      <dt>Shared out per ride (amortised)</dt><dd>A weekly or yearly cost divided by the rides it covers, e.g. $239 ÷ 52 weeks ÷ 10 rides = $0.46 per ride.</dd>
      <dt>Free transfer</dt><dd>One free subway↔bus or bus↔bus change within 2 hours on OMNY; changes inside a subway station are always free.</dd>
      <dt>Paid transfer</dt><dd>Leaving one subway station and walking to another that is not connected: a second fare.</dd>
      <dt>Leave just in time</dt><dd>The first wait for a train or bus is not counted; you are assumed to time your departure.</dd>
      <dt>Classic bike / e-bike</dt><dd>Citi Bike's pedal bike (flat price per 30 min) and pedal-assist bike (per minute, faster).</dd>
      <dt>Unlock fee</dt><dd>The $4.99 charged to start a Citi Bike e-bike ride without a membership. For classic bikes the $4.99 is the price of the ride itself.</dd>
      <dt>Dock swap</dt><dd>Docking and taking a fresh bike to reset the included minutes.</dd>
      <dt>Pickup wait</dt><dd>Typical time from requesting a car to it arriving, from real Uber/Lyft trips.</dd>
      <dt>Real trips / estimate</dt><dd>Car price based on actual fares for that pair of taxi zones, or on the citywide formula when there are too few trips.</dd>
      <dt>Taxi zone</dt><dd>One of 262 NYC TLC areas that trip records are grouped by.</dd>
      <dt>Hypothetical fares</dt><dd>Shown when any What if? price differs from today's.</dd>
      <dt>km² reachable</dt><dd>Total area of hexagons you can reach within the budget (cumulative by price band).</dd>
      <dt>GTFS</dt><dd>The standard file format transit agencies use to publish timetables.</dd>
      <dt>RAPTOR</dt><dd>A fast timetable route-finding method; the multi-criteria version keeps time and cost trade-offs.</dd>
    </dl>
  </section>

  <section data-s="data" hidden>
    <ul>
      <li><b>Timetables (GTFS):</b> MTA subway, NYCT and MTA Bus (all boroughs), LIRR, Metro-North, PATH, NYC Ferry, NYC DOT Staten Island Ferry, downloaded 8 Nov 2026.</li>
      <li><b>Streets:</b> OpenStreetMap (BBBike New York extract, Nov 2026).</li>
      <li><b>Uber/Lyft &amp; taxi trips:</b> NYC TLC trip records, Jul–Sep 2026; taxi zone boundaries.</li>
      <li><b>Citi Bike:</b> live station list (GBFS) and September 2026 trip records.</li>
      <li><b>Fares:</b> MTA, PANYNJ, NYC Ferry and Citi Bike published prices as of Nov 2026.</li>
      <li><b>Basemap:</b> OpenFreeMap / OpenMapTiles, © OpenStreetMap contributors.</li>
    </ul>
  </section>
  </div>
</div>`;

export function setupAbout() {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'about-btn'; btn.textContent = 'How it works';
  document.querySelector('.bar .brand')?.appendChild(btn);
  const overlay = document.createElement('div');
  overlay.className = 'about-overlay'; overlay.hidden = true; overlay.innerHTML = HTML;
  document.body.appendChild(overlay);
  const close = () => { overlay.hidden = true; btn.focus(); };
  btn.addEventListener('click', () => { overlay.hidden = false; overlay.querySelector<HTMLButtonElement>('.about-close')!.focus(); });
  overlay.querySelector('.about-close')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
  const tabs = [...overlay.querySelectorAll<HTMLButtonElement>('.about-tabs button')];
  for (const t of tabs) t.addEventListener('click', () => {
    for (const x of tabs) x.setAttribute('aria-selected', String(x === t));
    overlay.querySelectorAll<HTMLElement>('section[data-s]').forEach((s) => { s.hidden = s.dataset.s !== t.dataset.t; });
    overlay.querySelector('.about-body')!.scrollTop = 0;
  });
}
