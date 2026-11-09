"""Citi Bike docks + real riding speeds on our tile graph.

Outputs:
  citibike.json   docks (name, lat, lng, tile), speeds m/s [type][hourbin 0..47] on graph metres
  egress_dock.bin int32[N*KD], egress_dock_s.bin uint16[N*KD]  nearest docks per tile (walk)
hourbin = hour (0-23) on weekdays, 24 + hour on Sat/Sun.
"""
import json

import duckdb
import h3
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from common import RAW, BUILD, H3_RES, WALK_MPS, K_DOCKS_PER_TILE, haversine_m, save_bin, save_json

MAX_DOCK_WALK_S = 10 * 60


def main():
    tiles = (BUILD / "tiles.txt").read_text().split("\n")
    tidx = {c: i for i, c in enumerate(tiles)}
    ll = np.load(BUILD / "tiles_ll.npy")
    a, b, L = np.load(BUILD / "graph_csr.npy")
    n = len(tiles)
    G = csr_matrix((L, (a.astype(int), b.astype(int))), shape=(n, n))

    def snap(lat, lng, maxd=200):
        c = h3.latlng_to_cell(lat, lng, H3_RES)
        if c in tidx:
            return tidx[c]
        best, bd = -1, 1e9
        for nb in h3.grid_disk(c, 2):
            j = tidx.get(nb)
            if j is not None:
                d = haversine_m(lat, lng, ll[j, 0], ll[j, 1])
                if d < bd:
                    best, bd = j, d
        return best if bd <= maxd else -1

    st = json.loads((RAW / "citibike" / "station_information.json").read_text())["data"]["stations"]
    docks = []
    for s in st:
        t = snap(s["lat"], s["lon"])
        if t >= 0:
            docks.append(dict(name=s["name"], lat=s["lat"], lng=s["lon"], tile=t))
    print("docks in coverage", len(docks), "of", len(st))
    dock_tile = np.array([d["tile"] for d in docks])

    # nearest docks per tile
    K = K_DOCKS_PER_TILE
    ut = np.unique(dock_tile)
    D = dijkstra(G, directed=False, indices=ut, limit=MAX_DOCK_WALK_S * WALK_MPS)
    by_tile = {t: [i for i, x in enumerate(dock_tile) if x == t] for t in ut}
    cand_t, cand_d, cand_k = [], [], []
    for row, t in enumerate(ut):
        reach = np.nonzero(np.isfinite(D[row]))[0]
        for di in by_tile[t]:
            cand_t.append(reach); cand_d.append(D[row, reach]); cand_k.append(np.full(len(reach), di))
    cand_t = np.concatenate(cand_t); cand_d = np.concatenate(cand_d); cand_k = np.concatenate(cand_k)
    order = np.lexsort((cand_d, cand_t))
    cand_t, cand_d, cand_k = cand_t[order], cand_d[order], cand_k[order]
    first = np.searchsorted(cand_t, np.arange(n)); last = np.searchsorted(cand_t, np.arange(n), side="right")
    eg = -np.ones((n, K), np.int32); egs = np.zeros((n, K), np.uint16)
    for t in range(n):
        lo, hi = first[t], min(last[t], first[t] + K)
        eg[t, :hi - lo] = cand_k[lo:hi]; egs[t, :hi - lo] = np.round(cand_d[lo:hi] / WALK_MPS)
    save_bin("egress_dock.bin", eg.ravel()); save_bin("egress_dock_s.bin", egs.ravel())
    print("tiles within 10 min walk of a dock:", int((eg[:, 0] >= 0).sum()), "/", n)

    # riding speeds from trip histories, measured on our graph
    con = duckdb.connect()
    trips = con.sql(f"""
        select rideable_type as typ, start_lat, start_lng, end_lat, end_lng,
               epoch(ended_at - started_at) as dur,
               (case when dayofweek(started_at) in (0,6) then 24 else 0 end) + hour(started_at) as hb
        from read_csv_auto('{(RAW / 'citibike' / 'trips').as_posix()}/*.csv', types={{'start_station_id':'VARCHAR','end_station_id':'VARCHAR'}})
        where start_station_id <> end_station_id and start_lat is not null and end_lat is not null
          and epoch(ended_at - started_at) between 120 and 3600
        using sample 400000
    """).df()
    trips["t0"] = [snap(a, b, 300) for a, b in zip(trips.start_lat, trips.start_lng)]
    trips["t1"] = [snap(a, b, 300) for a, b in zip(trips.end_lat, trips.end_lng)]
    trips = trips[(trips.t0 >= 0) & (trips.t1 >= 0)]
    # graph distance for trips from a sample of origin tiles
    origins = trips.t0.value_counts().index[:1500].to_numpy()
    trips = trips[trips.t0.isin(set(origins))]
    gd = np.full(len(trips), np.nan)
    pos = {t: i for i, t in enumerate(origins)}
    for k in range(0, len(origins), 300):
        batch = origins[k:k + 300]
        DD = dijkstra(G, directed=False, indices=batch)
        sel = trips.t0.isin(set(batch)).to_numpy()
        rows = np.array([pos[t] - k for t in trips.t0[sel]])
        gd[sel] = DD[rows, trips.t1[sel].to_numpy()]
    trips["gd"] = gd
    trips = trips[np.isfinite(trips.gd) & (trips.gd > 400)]
    trips["v"] = trips.gd / trips.dur
    # keep "direct" rides: drop the slowest third (leisure rides that wander)
    out = {}
    for typ, key in (("classic_bike", "classic"), ("electric_bike", "ebike")):
        x = trips[trips.typ == typ]
        sp = []
        for hb in range(48):
            v = x.v[x.hb == hb]
            sp.append(round(float(np.quantile(v, 0.6)) if len(v) > 200 else float("nan"), 3))
        sp = np.array(sp, dtype=float)
        sp[np.isnan(sp)] = np.nanmedian(sp)
        out[key] = sp.round(3).tolist()
        print(key, "speed m/s (graph) weekday 8am", out[key][8], "range", sp.min(), sp.max(), "n", len(x))

    save_json("citibike.json", {
        "docks": {"name": [d["name"] for d in docks], "lat": [d["lat"] for d in docks],
                  "lng": [d["lng"] for d in docks], "tile": dock_tile.tolist()},
        "speed": out,
    })


if __name__ == "__main__":
    main()
