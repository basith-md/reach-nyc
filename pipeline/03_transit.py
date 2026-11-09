"""Merge GTFS feeds, clip to the tile coverage, and pack RAPTOR data for the browser.

Shared outputs:
  stops.json            names, lat/lng, tile, mode; routes meta
  stops_tile.bin        int32[S]  tile index of each stop
  foot_off/foot_to/foot_s/foot_flag  stop->stop footpaths (flag bit0 = in-system subway transfer)
  egress_stop.bin       int32[N*K] nearest stops per tile (-1 = none), egress_s.bin uint16[N*K] walk seconds
Per day type (wkd, sat, sun):
  tt_<d>_pat.bin        int32[P*3]  (stopsOffset, nStops, route)  ...see pack()
  tt_<d>_pstops.bin     int32       stop indices per pattern
  tt_<d>_ptrips.bin     int32[P+1]  trip offsets per pattern (trip counts)
  tt_<d>_arr.bin / _dep.bin int32   times, pattern-major, trip-major inside a pattern
"""
import re
import zipfile
from collections import defaultdict
from datetime import date, timedelta

import h3
import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from common import (RAW, BUILD, H3_RES, WALK_MPS, MAX_EGRESS_WALK_S, K_STOPS_PER_TILE,
                    haversine_m, save_bin, save_json)

FEEDS = {
    # name: (namespace for ids, default mode)
    "subway": ("sub", "subway"),
    "bus_bx": ("bus", "bus"), "bus_b": ("bus", "bus"), "bus_m": ("bus", "bus"),
    "bus_q": ("bus", "bus"), "bus_si": ("bus", "bus"), "bus_busco": ("bus", "bus"),
    "lirr": ("lirr", "rail"), "mnr": ("mnr", "rail"),
    "path": ("path", "path"),
    "nycferry": ("nycf", "ferry"),
    "siferry": ("sif", "free"),
}
DAYS = {"wkd": date(2026, 11, 10), "sat": date(2026, 11, 14), "sun": date(2026, 11, 15)}
EXPRESS = re.compile(r"^(BM|BxM|BXM|QM|SIM|X)\d", re.I)
FOOT_MAX_M = 400  # stop-to-stop transfer walk


def read(z: zipfile.ZipFile, name: str):
    m = [x for x in z.namelist() if x.split("/")[-1] == name]
    if not m:
        return None
    return pd.read_csv(z.open(m[0]), dtype=str, keep_default_na=False)


def tsec(s: pd.Series) -> np.ndarray:
    p = s.str.split(":", expand=True).astype(int)
    return (p[0] * 3600 + p[1] * 60 + p[2]).to_numpy()


def active_services(cal, cd, d: date) -> set:
    ds = d.strftime("%Y%m%d")
    wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
    act = set()
    if cal is not None and len(cal):
        m = (cal.start_date <= ds) & (cal.end_date >= ds) & (cal[wd] == "1")
        act |= set(cal.service_id[m])
    if cd is not None and len(cd):
        x = cd[cd.date == ds]
        act |= set(x.service_id[x.exception_type == "1"])
        act -= set(x.service_id[x.exception_type == "2"])
    return act


def pick_date(cal, cd, trips, target: date) -> date:
    """Target date if it has normal service; otherwise the busiest same-weekday date in the feed."""
    per_service = trips.service_id.value_counts()
    def count(d):
        return int(per_service.reindex(list(active_services(cal, cd, d))).fillna(0).sum())
    dates = []
    if cal is not None and len(cal):
        dates += [cal.start_date.min(), cal.end_date.max()]
    if cd is not None and len(cd):
        dates += [cd.date.min(), cd.date.max()]
    lo = pd.to_datetime(min(dates)).date(); hi = pd.to_datetime(max(dates)).date()
    cands = []
    d = lo
    while d <= hi:
        if d.weekday() == target.weekday():
            cands.append(d)
        d += timedelta(days=1)
    best = max(cands, key=count) if cands else target
    if lo <= target <= hi and count(target) >= 0.5 * count(best):
        return target
    return best


def main():
    tiles = (BUILD / "tiles.txt").read_text().split("\n")
    tidx = {c: i for i, c in enumerate(tiles)}
    ll = np.load(BUILD / "tiles_ll.npy")
    a, b, L = np.load(BUILD / "graph_csr.npy")
    n = len(tiles)
    G = csr_matrix((L, (a.astype(int), b.astype(int))), shape=(n, n))

    def snap(lat, lng):
        c = h3.latlng_to_cell(lat, lng, H3_RES)
        if c in tidx:
            return tidx[c]
        best, bd = -1, 1e9
        for nb in h3.grid_disk(c, 3):
            j = tidx.get(nb)
            if j is not None:
                d = haversine_m(lat, lng, ll[j, 0], ll[j, 1])
                if d < bd:
                    best, bd = j, d
        return best if bd <= 350 else -1

    stops = {}        # global stop id -> dict
    routes = {}       # global route id -> dict
    trip_rows = []    # per day: list of DataFrames
    st_by_day = defaultdict(list)
    seen_trips = defaultdict(set)
    subway_transfers = None

    for feed, (ns, mode) in FEEDS.items():
        z = zipfile.ZipFile(RAW / "gtfs" / f"{feed}.zip")
        st, r, t, stt = read(z, "stops.txt"), read(z, "routes.txt"), read(z, "trips.txt"), read(z, "stop_times.txt")
        cal, cd, fq = read(z, "calendar.txt"), read(z, "calendar_dates.txt"), read(z, "frequencies.txt")
        # stops
        for row in st.itertuples():
            gid = f"{ns}:{row.stop_id}"
            if gid in stops or not row.stop_lat:
                continue
            if getattr(row, "location_type", "") not in ("", "0"):
                continue
            ti = snap(float(row.stop_lat), float(row.stop_lon))
            if ti < 0:
                continue
            stops[gid] = dict(name=row.stop_name, lat=float(row.stop_lat), lng=float(row.stop_lon), tile=ti,
                              parent=f"{ns}:{getattr(row, 'parent_station', '')}" if getattr(row, "parent_station", "") else gid)
        # routes
        for row in r.itertuples():
            gid = f"{ns}:{row.route_id}"
            if gid in routes:
                continue
            short = getattr(row, "route_short_name", "") or getattr(row, "route_long_name", "") or row.route_id
            m = mode
            if ns == "bus" and EXPRESS.match(short):
                m = "express"
            if ns == "sub" and getattr(row, "route_type", "") == "2":
                m = "subway"  # Staten Island Railway, fare-equivalent
            if ns == "nycf" and getattr(row, "route_type", "") == "3":
                m = "free"    # NYC Ferry shuttle buses
            color = getattr(row, "route_color", "") or ""
            routes[gid] = dict(name=short, long=getattr(row, "route_long_name", "") or "", mode=m,
                               color=("#" + color) if color else "")
        if ns == "sub":
            subway_transfers = read(z, "transfers.txt")

        stt = stt[["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"]].copy()
        stt["stop_sequence"] = stt.stop_sequence.astype(int)
        for day, target in DAYS.items():
            d = pick_date(cal, cd, t, target)
            svc = active_services(cal, cd, d)
            tt = t[t.service_id.isin(svc)]
            tt = tt[~tt.trip_id.map(lambda x: f"{ns}:{x}" in seen_trips[day])]
            seen_trips[day].update(f"{ns}:{x}" for x in tt.trip_id)
            print(f"{feed:10s} {day} date={d} trips={len(tt)}")
            x = stt[stt.trip_id.isin(set(tt.trip_id))].merge(tt[["trip_id", "route_id"]], on="trip_id")
            x["trip"] = ns + ":" + feed + ":" + x.trip_id
            x["stop"] = ns + ":" + x.stop_id
            x["route"] = ns + ":" + x.route_id
            x = x[x.stop.isin(stops)]
            x = x[(x.arrival_time != "") | (x.departure_time != "")]
            arr = x.arrival_time.where(x.arrival_time != "", x.departure_time)
            dep = x.departure_time.where(x.departure_time != "", x.arrival_time)
            x = x.assign(arr=tsec(arr), dep=tsec(dep))[["trip", "route", "stop", "stop_sequence", "arr", "dep"]]
            # frequency-based trips -> expand
            if fq is not None and len(fq):
                fq2 = fq.assign(trip=ns + ":" + feed + ":" + fq.trip_id)
                exp = []
                for f in fq2.itertuples():
                    base = x[x.trip == f.trip].sort_values("stop_sequence")
                    if base.empty:
                        continue
                    s0 = base.dep.iloc[0]
                    start, end, hw = tsec(pd.Series([f.start_time]))[0], tsec(pd.Series([f.end_time]))[0], int(f.headway_secs)
                    for k, t0 in enumerate(range(start, end, hw)):
                        e = base.copy(); e["trip"] = f"{f.trip}#{k}"
                        e["arr"] += t0 - s0; e["dep"] += t0 - s0
                        exp.append(e)
                x = pd.concat([x[~x.trip.isin(set(fq2.trip))]] + exp) if exp else x
            st_by_day[day].append(x)

    # ---- stop indexing
    sids = sorted(stops)
    sidx = {s: i for i, s in enumerate(sids)}
    S = len(sids)
    stop_tile = np.array([stops[s]["tile"] for s in sids], dtype=np.int32)
    print("stops kept", S)

    # ---- walking distances stop -> tiles (for egress table + footpaths)
    uniq_tiles = np.unique(stop_tile)
    trip_t, trip_s, trip_d = [], [], []
    tiles_of = defaultdict(list)
    for i, ti in enumerate(stop_tile):
        tiles_of[ti].append(i)
    max_m = MAX_EGRESS_WALK_S * WALK_MPS
    for k in range(0, len(uniq_tiles), 400):
        batch = uniq_tiles[k:k + 400]
        D = dijkstra(G, directed=False, indices=batch, limit=max_m)
        for row, src_tile in enumerate(batch):
            reach = np.nonzero(np.isfinite(D[row]))[0]
            for si in tiles_of[src_tile]:
                trip_t.append(reach); trip_s.append(np.full(len(reach), si)); trip_d.append(D[row, reach])
        print(f"  walk dijkstra {min(k+400, len(uniq_tiles))}/{len(uniq_tiles)}", flush=True)
    trip_t = np.concatenate(trip_t); trip_s = np.concatenate(trip_s); trip_d = np.concatenate(trip_d)

    # egress table: K nearest stops per tile
    order = np.lexsort((trip_d, trip_t))
    tt_, ss_, dd_ = trip_t[order], trip_s[order], trip_d[order]
    first = np.searchsorted(tt_, np.arange(n))
    last = np.searchsorted(tt_, np.arange(n), side="right")
    K = K_STOPS_PER_TILE
    eg_stop = -np.ones((n, K), dtype=np.int32)
    eg_s = np.zeros((n, K), dtype=np.uint16)
    for ti in range(n):
        lo, hi = first[ti], min(last[ti], first[ti] + K)
        m = hi - lo
        if m > 0:
            eg_stop[ti, :m] = ss_[lo:hi]
            eg_s[ti, :m] = np.round(dd_[lo:hi] / WALK_MPS)
    save_bin("egress_stop.bin", eg_stop.ravel())
    save_bin("egress_s.bin", eg_s.ravel())
    np.save(BUILD / "stop_walk_triples.npy", np.stack([trip_t, trip_s, trip_d]))

    # footpaths: stop -> stops on tiles within FOOT_MAX_M
    foot = defaultdict(dict)  # from -> {to: (sec, flag)}
    near = trip_d <= FOOT_MAX_M
    for ti, si, d in zip(trip_t[near], trip_s[near], trip_d[near]):
        for sj in tiles_of.get(ti, ()):
            if sj != si:
                sec = max(30, int(d / WALK_MPS))
                if sj not in foot[si] or foot[si][sj][0] > sec:
                    foot[si][sj] = (sec, 0)
    # same-tile stops (distance 0 above) -> use straight line
    # subway in-system transfers (platform level)
    parent_of = defaultdict(list)
    for s in sids:
        parent_of[stops[s]["parent"]].append(sidx[s])
    if subway_transfers is not None:
        for row in subway_transfers.itertuples():
            pa, pb = parent_of.get(f"sub:{row.from_stop_id}", []), parent_of.get(f"sub:{row.to_stop_id}", [])
            sec = int(row.min_transfer_time or 120)
            for i in pa:
                for j in pb:
                    if i != j:
                        foot[i][j] = (sec, 1)
    off = np.zeros(S + 1, dtype=np.int32)
    to, secs, flags = [], [], []
    for i in range(S):
        items = sorted(foot[i].items())
        off[i + 1] = off[i] + len(items)
        for j, (sec, fl) in items:
            to.append(j); secs.append(sec); flags.append(fl)
    save_bin("foot_off.bin", off)
    save_bin("foot_to.bin", np.array(to, dtype=np.int32))
    save_bin("foot_s.bin", np.array(secs, dtype=np.uint16))
    save_bin("foot_flag.bin", np.array(flags, dtype=np.uint8))
    save_bin("stops_tile.bin", stop_tile)
    print("footpaths", len(to))

    # ---- routes
    rids = sorted(routes)
    ridx = {r: i for i, r in enumerate(rids)}

    # ---- per day timetables
    for day in DAYS:
        x = pd.concat(st_by_day[day], ignore_index=True)
        x["s"] = x.stop.map(sidx)
        x = x.sort_values(["trip", "stop_sequence"])
        g = x.groupby("trip", sort=False)
        trips = []
        for trip, df in g:
            if len(df) < 2:
                continue
            s = df.s.to_numpy(); ar = df.arr.to_numpy(); dp = df.dep.to_numpy()
            # drop consecutive duplicate stops
            keep = np.ones(len(s), bool); keep[1:] = s[1:] != s[:-1]
            s, ar, dp = s[keep], ar[keep], dp[keep]
            if len(s) < 2:
                continue
            trips.append((ridx[df.route.iloc[0]], tuple(s.tolist()), ar, dp))
        # group into patterns, then split into FIFO sub-patterns
        groups = defaultdict(list)
        for rt, seq, ar, dp in trips:
            groups[(rt, seq)].append((ar, dp))
        pat_meta, pstops, ptrip_off, arr_all, dep_all = [], [], [0], [], []
        for (rt, seq), tl in groups.items():
            tl.sort(key=lambda t: t[1][0])
            subs: list[list] = []
            for tr in tl:
                for sp in subs:
                    last = sp[-1]
                    if np.all(tr[1] >= last[1]) and np.all(tr[0] >= last[0]):
                        sp.append(tr); break
                else:
                    subs.append([tr])
            for sp in subs:
                pat_meta.append((len(pstops), len(seq), rt))
                pstops.extend(seq)
                ptrip_off.append(ptrip_off[-1] + len(sp))
                for ar, dp in sp:
                    arr_all.append(ar); dep_all.append(dp)
        arr_all = np.concatenate(arr_all).astype(np.int32)
        dep_all = np.concatenate(dep_all).astype(np.int32)
        save_bin(f"tt_{day}_pat.bin", np.array(pat_meta, dtype=np.int32).ravel())
        save_bin(f"tt_{day}_pstops.bin", np.array(pstops, dtype=np.int32))
        save_bin(f"tt_{day}_ptrips.bin", np.array(ptrip_off, dtype=np.int32))
        save_bin(f"tt_{day}_arr.bin", arr_all)
        save_bin(f"tt_{day}_dep.bin", dep_all)
        print(f"{day}: patterns={len(pat_meta)} trips={ptrip_off[-1]} stoptimes={len(arr_all)}")

    save_json("stops.json", {
        "names": [stops[s]["name"] for s in sids],
        "lat": [round(stops[s]["lat"], 6) for s in sids],
        "lng": [round(stops[s]["lng"], 6) for s in sids],
        "ns": [s.split(":")[0] for s in sids],
        "routes": [{"name": routes[r]["name"], "long": routes[r]["long"], "mode": routes[r]["mode"], "color": routes[r]["color"]} for r in rids],
    })
    print("done")


if __name__ == "__main__":
    main()
