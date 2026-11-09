"""Uber/Lyft (HVFHV) and yellow/green taxi price + time model from TLC trip records.

price (before tips and tolls) = (a + b*miles + c*minutes) per hourbin  [OLS over all trips]
  x zone-pair ratio when the pair has enough trips and a tight spread ("observed"), else 1 ("estimate")
miles   = straight line (tile to tile) x detour factor (zone pair, else global)
minutes = miles / (hourbin speed x zone-pair speed factor)
tolls   = zone-pair median tolls (observed pairs only)
Uber wait = median(on_scene - request) by pickup zone x hourbin.

Outputs: ride_model.json and pair tables ride_pair_<name>.bin (float32 [Z*Z], Z = 264, index = PU*264 + DO)
"""
import duckdb
import geopandas as gpd
import numpy as np

from common import RAW, haversine_m, save_bin, save_json

Z = 264
MIN_N = 30
MAX_SPREAD = 0.6   # (q75 - q25) / median of the ratio
TLC = (RAW / "tlc").as_posix()

HB = "(case when dayofweek({t}) in (0,6) then 24 else 0 end) + hour({t})"

SOURCES = {
    "hv": f"""
        select PULocationID pu, DOLocationID do_, trip_miles miles, trip_time/60.0 mins,
               base_passenger_fare + bcf + sales_tax + congestion_surcharge + coalesce(airport_fee,0) + coalesce(cbd_congestion_fee,0) price,
               tolls, {HB.format(t='pickup_datetime')} hb,
               epoch(on_scene_datetime - request_datetime) wait
        from '{TLC}/fhvhv_*.parquet'
        where shared_match_flag = 'N' and base_passenger_fare > 0
    """,
    "taxi": f"""
        select PULocationID pu, DOLocationID do_, trip_distance miles,
               epoch(tpep_dropoff_datetime - tpep_pickup_datetime)/60.0 mins,
               fare_amount + extra + mta_tax + improvement_surcharge + coalesce(congestion_surcharge,0) + coalesce(Airport_fee,0) + coalesce(cbd_congestion_fee,0) price,
               tolls_amount tolls, {HB.format(t='tpep_pickup_datetime')} hb, null::double wait
        from '{TLC}/yellow_*.parquet' where RatecodeID in (1, 2) and fare_amount > 0
        union all
        select PULocationID, DOLocationID, trip_distance,
               epoch(lpep_dropoff_datetime - lpep_pickup_datetime)/60.0,
               fare_amount + extra + mta_tax + improvement_surcharge + coalesce(congestion_surcharge,0) + coalesce(cbd_congestion_fee,0),
               tolls_amount, {HB.format(t='lpep_pickup_datetime')}, null
        from '{TLC}/green_*.parquet' where RatecodeID in (1, 2) and fare_amount > 0
    """,
}


def main():
    zones = gpd.read_file(RAW / "tlc" / "zones" / "taxi_zones" / "taxi_zones.shp").to_crs(2263)
    cent = zones.set_index("LocationID").geometry.centroid.to_crs(4326)
    zl = np.full((Z, 2), np.nan)
    for zid, p in cent.items():
        zl[int(zid)] = (p.y, p.x)

    con = duckdb.connect()
    con.sql("set threads to 8")
    model = {}
    for name, sql in SOURCES.items():
        con.sql(f"""create or replace table t as select * from ({sql})
                    where pu between 1 and 263 and do_ between 1 and 263 and pu <> 1 and do_ <> 1
                      and miles between 0.1 and 60 and mins between 1 and 180 and price between 2.5 and 400
                      and miles / (mins/60) between 1 and 65""")
        cnt = con.execute("select count(*) from t").fetchone()[0]
        print(name, "trips", cnt)

        # OLS per hourbin via normal equations
        rows = con.execute("""select hb, count(*), sum(miles), sum(mins), sum(price), sum(miles*miles), sum(miles*mins),
                                 sum(mins*mins), sum(miles*price), sum(mins*price), median(miles/(mins/60)),
                                 quantile_cont(price, 0.02)
                          from t group by hb order by hb""").fetchall()
        coef, speed, floor = [], [], []
        for r in rows:
            _, n, sm, st, sp, smm, smt, stt, smp, stp, mph, q02 = r
            A = np.array([[n, sm, st], [sm, smm, smt], [st, smt, stt]])
            y = np.array([sp, smp, stp])
            coef.append(np.linalg.solve(A, y).round(4).tolist())
            speed.append(round(mph, 3)); floor.append(round(q02, 2))
        con.execute("create or replace table hbm as select unnest(range(48)) hb, unnest(?::double[]) a, unnest(?::double[]) b, unnest(?::double[]) c, unnest(?::double[]) mph",
                    [[c[0] for c in coef], [c[1] for c in coef], [c[2] for c in coef], speed])

        # zone-pair statistics
        pair = con.execute("""
            select pu, do_, count(*) n,
                   median(price / (a + b*miles + c*mins)) ratio,
                   quantile_cont(price / (a + b*miles + c*mins), 0.25) r25,
                   quantile_cont(price / (a + b*miles + c*mins), 0.75) r75,
                   median(tolls) tolls, median(miles) miles,
                   median((miles/(mins/60)) / mph) spf
            from t join hbm using (hb) group by pu, do_""").df()
        ratio = np.ones(Z * Z, np.float32); spread = np.full(Z * Z, 9, np.float32)
        nn = np.zeros(Z * Z, np.float32); tolls = np.zeros(Z * Z, np.float32)
        spf = np.ones(Z * Z, np.float32); dmiles = np.full(Z * Z, np.nan, np.float32)
        k = pair.pu.to_numpy() * Z + pair.do_.to_numpy()
        nn[k] = pair.n; ratio[k] = pair.ratio; spread[k] = (pair.r75 - pair.r25) / pair.ratio
        tolls[k] = pair.tolls.fillna(0); spf[k] = np.where(pair.n >= MIN_N, pair.spf, 1); dmiles[k] = pair.miles
        ok = (nn >= MIN_N) & (spread <= MAX_SPREAD)
        ratio[~ok] = 1; tolls[~ok] = 0
        print(f"  pairs with data {int((nn>0).sum())}, observed (n>={MIN_N}, tight) {int(ok.sum())}; "
              f"share of trips covered {nn[ok].sum()/nn.sum():.3f}")
        save_bin(f"ride_{name}_ratio.bin", ratio)
        save_bin(f"ride_{name}_n.bin", np.minimum(nn, 65535).astype(np.uint16))
        save_bin(f"ride_{name}_spread.bin", spread)
        save_bin(f"ride_{name}_tolls.bin", tolls)
        save_bin(f"ride_{name}_spf.bin", spf)

        m = {"coef": coef, "mph": speed, "floor": floor}
        if name == "hv":
            w = con.execute("""select pu, hb, median(wait) from t where wait between 0 and 3600 group by pu, hb""").fetchall()
            wait = np.full((Z, 48), np.nan)
            for pu, hb, s in w:
                wait[pu, hb] = s
            fill = np.nanmedian(wait, axis=0)
            wait = np.where(np.isnan(wait), fill[None, :], wait)
            save_bin("ride_hv_wait.bin", np.round(wait).astype(np.uint16).ravel())
            m["wait_median_s"] = float(np.nanmedian(wait))
            # detour factor per zone pair: median trip miles vs straight line between zone centroids
            pu = np.arange(Z).repeat(Z); do = np.tile(np.arange(Z), Z)
            straight = haversine_m(zl[pu, 0], zl[pu, 1], zl[do, 0], zl[do, 1]) / 1609.34
            det = dmiles / straight
            good = (straight > 1.0) & np.isfinite(det) & (nn >= MIN_N)
            gdet = float(np.median(det[good]))
            det = np.where(good, np.clip(det, 1.0, 2.5), gdet).astype(np.float32)
            save_bin("ride_detour.bin", det)
            m["detour_global"] = round(gdet, 3)
            print("  global detour", gdet, "median wait s", m["wait_median_s"])
        model[name] = m
        print(f"  weekday 8am: ${coef[8][0]:.2f} + ${coef[8][1]:.2f}/mi + ${coef[8][2]:.2f}/min, {speed[8]} mph")

    model["zones"] = {"lat": np.nan_to_num(zl[:, 0]).round(5).tolist(), "lng": np.nan_to_num(zl[:, 1]).round(5).tolist(),
                      "name": [""] + [str(x) for x in zones.sort_values("LocationID").zone][: Z - 1]}
    model["min_n"] = MIN_N
    save_json("ride_model.json", model)


if __name__ == "__main__":
    main()
