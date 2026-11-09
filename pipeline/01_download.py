"""Download all raw inputs into data/raw. Skips files that already exist."""
import sys
from pathlib import Path

import requests

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
UA = {"User-Agent": "Mozilla/5.0 (nyc-reach research project)"}

MTA = "https://rrgtfsfeeds.s3.amazonaws.com/"
TLC = "https://d37ci6vzurychx.cloudfront.net/trip-data/"
TLC_MONTHS = ["2026-07", "2026-08", "2026-09"]

FILES = {
    # transit schedules
    "gtfs/subway.zip": MTA + "gtfs_subway.zip",
    "gtfs/bus_bx.zip": MTA + "gtfs_bx.zip",
    "gtfs/bus_b.zip": MTA + "gtfs_b.zip",
    "gtfs/bus_m.zip": MTA + "gtfs_m.zip",
    "gtfs/bus_q.zip": MTA + "gtfs_q.zip",
    "gtfs/bus_si.zip": MTA + "gtfs_si.zip",
    "gtfs/bus_busco.zip": MTA + "gtfs_busco.zip",
    "gtfs/lirr.zip": MTA + "gtfslirr.zip",
    "gtfs/mnr.zip": MTA + "gtfsmnr.zip",
    "gtfs/path.zip": "http://data.trilliumtransit.com/gtfs/path-nj-us/path-nj-us.zip",
    "gtfs/nycferry.zip": "http://nycferry.connexionz.net/rtt/public/resource/gtfs.zip",
    "gtfs/siferry.zip": "https://www.nyc.gov/html/dot/downloads/misc/siferry-gtfs.zip",
    # streets
    "osm/nyc.osm.pbf": "https://download.bbbike.org/osm/bbbike/NewYork/NewYork.osm.pbf",
    # zones
    "tlc/taxi_zones.zip": "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip",
    # citi bike
    "citibike/station_information.json": "https://gbfs.lyft.com/gbfs/1.1/bkn/en/station_information.json",
    "citibike/trips_202609.zip": "https://s3.amazonaws.com/tripdata/202609-citibike-tripdata.zip",
}
for m in TLC_MONTHS:
    FILES[f"tlc/fhvhv_{m}.parquet"] = TLC + f"fhvhv_tripdata_{m}.parquet"
    FILES[f"tlc/yellow_{m}.parquet"] = TLC + f"yellow_tripdata_{m}.parquet"
    FILES[f"tlc/green_{m}.parquet"] = TLC + f"green_tripdata_{m}.parquet"


def fetch(rel: str, url: str) -> None:
    out = RAW / rel
    if out.exists() and out.stat().st_size > 0:
        print("skip", rel, flush=True)
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".part")
    with requests.get(url, headers=UA, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    tmp.replace(out)
    print(f"ok   {rel}  {out.stat().st_size/1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    only = sys.argv[1:]
    failed = []
    for rel, url in FILES.items():
        if only and not any(o in rel for o in only):
            continue
        try:
            fetch(rel, url)
        except Exception as e:  # keep going, report at end
            failed.append(rel)
            print("FAIL", rel, e, flush=True)
    print("done; failed:", failed)
