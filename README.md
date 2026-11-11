# Reach NYC

**Mapping what it costs to move around New York.**
Live: **https://reach-nyc.vercel.app**

Drop a pin anywhere in the five boroughs and see everywhere you can reach within a time budget, with every hexagon coloured by the **cheapest** way to get there. Or flip it around: set a money budget and see how far it takes you. A city-wide simulation maps where transit gives you a lot for little, and where the gaps are.

All routing runs in your browser. There is no backend.

## What it does

- **Time or Money budget.** *Time*: everywhere reachable in N minutes, coloured by cheapest cost. *Money*: everywhere reachable for $X, coloured by fastest time. The **Threshold** pane sets the opposite limit (a max cost in Time mode, a longest trip in Money mode).
- **Every way to travel, mixed freely.** Walking, subway, local and express buses, LIRR / Metro-North (CityTicket), PATH, NYC Ferry and the Staten Island Ferry, Citi Bike classic and e-bike (including bike → train → bike, with dock swaps), Uber/Lyft and yellow taxis.
- **Real fares, not rounded.** OMNY's weekly fare cap and Citi Bike's annual membership are spread over your trips per week. Free transfers, CityTicket peak/off-peak, PATH passes and ferry 10-packs are all included. Uber and taxi prices come from real NYC TLC trips by hour and zone pair.
- **Hover any hexagon** for the cheapest route leg by leg, the fastest alternative, and what a bike or a car would cost.
- **What if?** sliders: change the subway fare, the fare cap or Citi Bike prices and watch the map redraw.
- **Simulation.** Drops 248 / 750 / 1,481 pins across the city with your current settings and maps the area each can reach, as **raw area** or **effective area** (see below). Export a PNG cropped to the city, or a CSV.

### Effective area

Raw km² penalises places next to water: a Midtown pin has rivers and New Jersey on two sides. Effective area corrects for that:

```
R              = average straight-line distance from the pin to everywhere it can reach
land fraction  = NYC land within R of the pin ÷ (π R²)        (floored at 25%)
effective area = area reachable ÷ land fraction
```

It answers: *how much would you reach if your surroundings were all land?*

## How it works

1. **The city as hexagons.** The five boroughs are cut into 46,792 [H3](https://h3geo.org/) hexagons, about 130 m across (resolution 10), linked by walkable OpenStreetMap streets and bridges.
2. **Transit: multi-criteria RAPTOR** over the GTFS timetables. It tracks *time × cost* with fare-state bits (free MTA transfer pending, in-system, ferry transfer, bike membership), runs four departures 15 min apart, and assumes you leave just in time. There is no first wait.
3. **Walking and biking:** Dijkstra on the hexagon graph. Citi Bike speeds are measured per hour of day from real trip data.
4. **Cars:** a per-hour regression on TLC trip records (distance, detour, speed, tolls, median wait). Pickups and drop-offs snap to streets a car can actually stop on, so not inside parks or plazas.
5. Everything runs in a Web Worker. A pin takes about 1.5–2 s. The simulation fans out across up to six workers.

## Data sources

| What | Source |
|---|---|
| Subway, buses, LIRR, Metro-North | [MTA GTFS](https://new.mta.info/developers) |
| PATH | Trillium GTFS |
| NYC Ferry, Staten Island Ferry | NYC Ferry GTFS, NYC DOT |
| Streets and walkable paths | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (BBBike extract) |
| Taxi and Uber/Lyft prices, taxi zones | [NYC TLC trip records](https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page), Jul–Sep 2026 |
| Citi Bike docks and ride speeds | Citi Bike GBFS and trip data, Sep 2026 |
| Basemap | [OpenFreeMap](https://openfreemap.org/) (Positron) |

Fares are in [`pipeline/fares.json`](pipeline/fares.json) (as of Nov 2026).

## Run it locally

The processed data (~51 MB) isn't in the repo. Build it with the Python pipeline first.

**1. Data pipeline** (Python 3.11+)

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install h3 geopandas shapely osmium duckdb scipy pandas numpy requests

cd pipeline
python 01_download.py     # GTFS, OSM, TLC, Citi Bike -> data/raw (several GB)
python 02_grid.py         # hexagon grid + walk graph
python 03_transit.py      # RAPTOR timetables, footpaths, egress
python 04_citibike.py     # docks + speeds by hour
python 05_ride_model.py   # Uber/Lyft + taxi price model
python 06_car_access.py   # where cars can stop
python 09_boundary.py     # NYC outline
```

Output goes to `web/public/data/`.

**2. Web app** (Node 20+)

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in web/dist
```

## Deploying

`web/dist` is a fully static site, so any static host works. The live site is deployed to Vercel from a local build, because the data isn't in git. `vercel.json` turns off Git-triggered deploys for that reason.

## Limitations

- Five boroughs only. Destinations in New Jersey or Nassau aren't mapped.
- Scheduled timetables, not real-time. No delays, crowding or service changes.
- Car prices are medians of real trips and leave out surge pricing.
- Values between simulation pins are interpolated.

The in-app **How it works** dialog covers the methodology, assumptions and a glossary in more detail.
