# NYC Reach-by-Cost Map: Plan (v3)

_Last updated 2026-11-08. Planning only; nothing is built yet. Items marked (verify) still need checking._

## 1. What the user sees

```
┌───────────────────────────────────────────────────────────────┐
│ ⚙ Advanced ▸          [ 30 ] min  [ 5 ]×/week  [Tue ▾][08:00] │
│ ┌───────────────┐                                             │
│ │ Tip taxi  15% │         ░░▒▒▓▓▓▓▒▒░                          │
│ │ Tip Uber  15% │       ░▒▓▓███📍██▓▒░     Cheapest way there  │
│ │ Taxi wait  5m │        ░▒▓▓████▓▓▒░       within 30 min:     │
│ │ Uber wait data│          ░▒▒▓▒▒░          █ $0   walk        │
│ │ Other subway  │                            ▓ $3   subway/bus │
│ │  rides/wk   0 │      ── boundary =         ▒ $4–8 bike+subway│
│ │ Count return ☑│         reachable at       ░ $8–20 PATH/rail │
│ │ Citi member:  │         any price            $20+ Uber/taxi  │
│ │  auto/yes/no  │                                             │
│ └───────────────┘  [x]Walk [x]Subway/bus [x]Citi Bike [x]PATH  │
│                    [x]Ferry [x]LIRR/MNR [x]Uber/Lyft [x]Taxi   │
└───────────────────────────────────────────────────────────────┘
```

**Main inputs (top right)**
- **Time budget** in minutes.
- **Trips per week** for this journey.
- **Day and departure time**: any time, not fixed bins.

**Map**
- **Drop a pin:** the reach is computed live in the browser.
- **Boundary:** everywhere reachable within T at any price.
- **Fill:** the minimum *effective* cost per trip, using stepped colors.
- **Hover a tile:** "$2.92/trip, 27 min: walk 4 → Citi Bike 9 → subway A 12 → walk 2. Fastest: Uber 16 min, $31 incl. tip."

**Advanced panel (left side)**
- Tip % for taxi and Uber/Lyft, default 0%.
- Taxi wait in minutes: **off by default**; when on, the user enters a number.
- Uber wait: taken from data, with an option to override it.
- Other subway/bus rides per week, which affects the $35 cap.
- "Count return trip", default on.
- Citi Bike membership: auto (cheapest), yes, or no.

## 2. Coverage

**Current scope (2026-11-08): the five boroughs only. NJ is deferred.**
- PATH is kept only for trips between its Manhattan stations (33rd St to Christopher St, and WTC).
- NJ Transit, Jersey City/Hoboken Citi Bike and NY Waterway are left for later.

The table below shows the eventual coverage.

| Mode | 5 boroughs | Jersey City / Hoboken | Source |
|---|---|---|---|
| Walk | ✅ | ✅ | OSM |
| Subway, local + express bus, SIR | ✅ | – | MTA GTFS |
| Citi Bike | ✅ | ✅ (JC/Hoboken stations are in the same feed) | GBFS + trip data |
| PATH | ✅ (Manhattan stations) | ✅ | PANYNJ GTFS |
| NJ Transit Hudson-Bergen Light Rail + buses | – | ✅ | NJT GTFS (free registration) |
| NYC Ferry, NY Waterway, Staten Island Ferry | ✅ | ✅ (NY Waterway) | GTFS feeds |
| LIRR / Metro-North inside the city (CityTicket) | ✅ | – | MTA GTFS + **fare PDFs (extract)** |
| Uber/Lyft | ✅ real data | ⚠️ estimate only | TLC HVFHV. Trips into NJ are recorded only as "outside NYC", and NJ pickups aren't recorded, so NJ uses the distance model plus tunnel tolls |
| Yellow/green taxi | ✅ real data | ⚠️ estimate only | TLC yellow/green. Fares to NJ are negotiated; use the model |

## 3. Trips per week: effective cost per trip

Input `n` = trips per week each way. With "count return" on, rides per week `r = 2n`; with it off, `r = n`. Every option's cost is converted to **cost per one-way trip**, choosing the cheapest payment method automatically.

| Mode | Pay per ride | Pass / cap | Effective per trip |
|---|---|---|---|
| Subway / local bus | $3.00 | OMNY cap **$35 / 7 days** (cap counts *all* rides, so include "other rides/week") | `min(3·R, 35) / R × (rides this journey uses)`, where R = this journey's rides + other rides |
| Express bus | $7.25 | cap $67 / 7 days (includes local and subway) | same logic |
| Citi Bike | $4.99 per classic ride (30 min); e-bike $4.99 + $0.41/min | member $239/yr ≈ **$4.60/wk**: classic rides ≤45 min included, e-bike $0.27/min | `min(per-ride, 4.60/r + member usage)`. Note: even 1 ride a week makes membership cheaper if you ride every week |
| PATH | single fare (verify $3.00) | 7-day and 30-day unlimited SmartLink (verify prices) | min of single vs pass ÷ rides |
| NJT light rail | single fare (verify) | weekly/monthly pass | same |
| NYC Ferry | single (verify) | 10-trip, 30-day pass | same |
| LIRR/MNR CityTicket | from fare PDFs | weekly ticket (from PDFs) | same |
| Uber/Lyft, taxi | per trip + tip % | none (Uber One possible later) | per trip |

Mixed trips **add** up their parts, e.g. Citi Bike (member, amortized) + subway (capped).

## 4. Routing engine: runs live in the browser

The server can't run a full routing engine (see §6), so routing happens on the **user's device** in a Web Worker:

- **Hex graph for walking and biking.** About 55k H3 resolution-10 tiles, each about 130 m across. Each tile links to its neighbours with OSM-derived walk and bike times, so it follows real streets and bridges and avoids water.
- **Transit: McRAPTOR**, multi-criteria RAPTOR that optimizes **arrival time and cost** together.
  - Runs over GTFS for all agencies in §2, using the departure time selected.
  - Fare rules: free subway↔bus transfer, express upcharge, separate PATH/NJT/ferry/rail fares, with pass amortization from §3.
- **Bike share is a first-class leg, so mixed trips are optimized.** Allowed legs:
  - walk → dock → **bike** → dock → walk (bike-only trips)
  - walk/bike → transit → walk/bike, i.e. bike to the subway, ride, and bike again at the other end
  - The bike leg is limited to dock locations. Bike speed comes from Citi Bike trip data by hour and bike type. Dock availability is ignored (decided).
- **Uber/Lyft and taxi:** direct, not chained with transit. Computed per destination tile from the price/time model (§5).
- **Output per tile:** the Pareto set of (time, cost). The map shows `min cost where time ≤ T`. Changing T or the toggles recolors instantly without re-routing; changing pin, time, day or trips per week re-runs the route search (target < 2 s).

### 4a. Fair waiting rules (decided 2026-11-08)
- **No first wait for any mode.** The default assumes you leave just in time: you arrive at the station or dock as the vehicle leaves, the same way taxi wait is excluded.
- **Transit:** run **range-RAPTOR** over the hour after the chosen time, and for each destination take the best "leave-just-in-time" trip.
  - Option: show a typical trip (median across departures) instead of the best one.
  - **Transfer waits still count**, since you can't time those.
- **Advanced toggle "Include first wait":** when on, it adds the scheduled wait for transit, the data-based wait for Uber, and the user-entered wait for taxi, all together.
- **Costs are exact to the cent; no rounding.** The search keeps every option where nothing else is both faster and cheaper, so per-minute e-bike prices stay visible.

### 4b. Sparse design (keeps each pin drop under ~0.5 s)
- **Origin:** walk search over street tiles within ~1.5 km only (~400 tiles), not all 55k.
- **Destination:** a pre-built table with each tile's nearest ~15 stops and docks and their walk times. Finishing a tile is `min(arrival[stop] + walk)`, a single pass with no route search.
- **Transit is the backbone:** the timetable search runs over ~17k stops, using only trips departing within [t0, t0+T].
- **Bike-share:** pre-computed dock→dock bike times for pairs within a 20-minute ride; each bike leg is a lookup.
- **Limits:** at most 4 transit legs. Load only trips departing between t0 and t0 + 60 min + T; this is a data-loading limit and doesn't change results.
- **First visit download:** about 6–10 MB compressed. Hosting cost is $0 on Vercel Hobby or Cloudflare Pages; refreshes run from a scheduled GitHub Actions job.

## 5. Uber/Lyft and taxi price model (decision 8)

Fit offline in Python with **duckdb** on 6 months of TLC data:

- **Model:** price excl. tolls and tip = f(trip distance, trip time) × zone×hour-of-week multiplier. Tolls are added back separately by route: bridges, tunnels, and the congestion zone fee ($1.50 Uber, $0.75 taxi).
- **Confidence per zone-pair × hour:** if there are ≥ N trips and the observed median is tight (IQR/median below a threshold), use the observed median **scaled to the actual tile-to-tile distance**. Otherwise use the model. Hover shows "based on 1,240 trips" or "estimate".
- **Taxi meter fallback** (verify current rates): $3 start, $0.70 per 1/5 mile, $0.70/min slow, plus surcharges, and the **JFK $70 flat fare**.
- **Ride time:** zone×hour speeds from TLC trip_time, applied to the network drive distance.
- **Uber wait:** median `on_scene − request` per zone×hour from the data. Taxi wait comes only from the Advanced setting.

**Why tile distance matters (decision 10).** TLC data only records *taxi zones*, about 3 km² each. Example: Upper West Side North (W 96th–110th St) is one zone.
- Without the fix, a 2-block ride and a 14-block ride inside that zone would both get the *same* median price, about $15.
- Without the fix, a pin at W 97th and one at W 109th would show identical Uber prices to Midtown.
- **Fix:** use the zone data for the *rate and surge* at that hour, and the real tile-to-tile distance for the *amount*.

## 6. Hosting: Vercel

- **Static site on Vercel (free tier):** the HTML/JS app plus pre-built data files. Vercel serves the files; **the user's browser does the computing**, so there are no servers to run and no cold starts.
- **Why not compute on Vercel servers:** full routing engines (R5, OpenTripPlanner) need Java, 4–8 GB RAM and minutes to start. Vercel functions are short-lived and limited in memory, so they don't suit this.
- **Data files** (approximate; loaded lazily, gzipped):
  - hex walk/bike graph: ~5–8 MB
  - GTFS timetable for the selected 3-hour window, split by day type × hour: ~2–4 MB per chunk
  - Citi Bike docks: <1 MB
  - Uber/taxi model tables: ~2 MB
- **Fallback if browser routing is too slow:** a small always-on routing server (Fly.io / Railway, ~$10–30/month) behind the same front end.

## 7. Fares to extract or verify
- **Extract from PDFs:** the LIRR and Metro-North fare tables, CityTicket fares and weekly tickets for in-city stations (MTA documents, e.g. mta.info/document/180021).
- **Verify:**
  - PATH single fare and passes
  - NJT light rail fares and passes
  - NYC Ferry and NY Waterway fares
  - 2026 taxi meter rates
  - Citi Bike e-bike Manhattan cap rules
  - bridge and tunnel tolls (MTA B&T 2026, PANYNJ Holland/Lincoln/GWB)
  - CBD congestion fee by vehicle type

## 8. Build pipeline

```
pipeline/   (Python 3.12, runs on this PC)
  01_download.py      GTFS (MTA, PATH, NJT, ferries), OSM NY+NJ, TLC 6 mo, Citi Bike trips + GBFS
  02_fares.py         PDF extraction (pdfplumber) + hand-checked fare/pass table → fares.json
  03_hexgraph.py      H3 res-10 land tiles, walk/bike edge times from OSM → binary graph
  04_gtfs_pack.py     merge feeds, clip to coverage, pack RAPTOR arrays per day type × hour
  05_citibike.py      docks → tiles, bike speeds by hour/type
  06_ride_model.py    duckdb on TLC → zone×hour multipliers, speeds, waits, confidence tables, fitted model
web/        (TypeScript, Vite → Vercel)
  worker/raptor.ts    McRAPTOR + hex Dijkstra + fare/pass logic
  map.ts              MapLibre GL + h3-js rendering, legend, hover itinerary
  ui/                 inputs, advanced panel, mode toggles
```

## 9. Phases
1. **Data pipeline + hex graph:** walk-only reach map on Vercel (proves the browser approach).
2. **Transit:** subway/bus McRAPTOR with $3 / $35 cap logic and time of day.
3. **Citi Bike:** bike-only and **bike+transit mixed trips**, with membership amortization.
4. **Uber/Lyft and taxi:** price model, tips, waits, confidence.
5. **More networks:** PATH, NJT light rail, ferries, CityTicket (PDF fares), Jersey City/Hoboken.
6. **Polish:** hover itineraries, performance tuning, deadzone summary stats.

## 10. Setup
- Install Python 3.12, Node.js 20+ and Git (Java is no longer needed).
- Get a free NJ Transit developer account for its GTFS.
- Set up a Vercel account and link the repo.
- Disk: about 12 GB (6 months of TLC Parquet).
