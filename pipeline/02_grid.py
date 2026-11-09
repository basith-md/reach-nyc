"""Build the H3 res-10 tile set and the walk/bike tile graph.

Tiles  = res-10 cells inside NYC taxi zones (land) that contain a walkable OSM way,
         plus cells along walkable/bikeable bridges (so bridges over rivers connect).
Edges  = between neighbouring tiles, only if the midpoint is on land or on a bridge
         (prevents jumping across narrow creeks).
Outputs (web/public/data):
  tiles_h3.bin   uint64[N]  H3 index
  tiles_ll.bin   float32[N,2] lat,lng
  tiles_zone.bin uint16[N]  taxi zone id (0 = none, e.g. bridge)
  tiles_flag.bin uint8[N]   bit0 Manhattan, bit1 bridge
  graph_off.bin  int32[N+1], graph_nbr.bin int32[E], graph_len.bin uint16[E] (metres incl. detour)
"""
import h3
import numpy as np
import osmium
import geopandas as gpd
import shapely
from shapely.geometry import LineString

from common import RAW, BUILD, H3_RES, WALK_DETOUR, haversine_m, save_bin, save_json

WALKABLE = {
    "footway", "pedestrian", "path", "steps", "cycleway", "living_street", "residential",
    "service", "unclassified", "tertiary", "tertiary_link", "secondary", "secondary_link",
    "primary", "primary_link", "trunk", "trunk_link", "track", "corridor", "bridleway", "road",
}


class WayHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.cells: set[str] = set()
        self.bridge_cells: set[str] = set()
        self.bridge_lines: list[LineString] = []

    def way(self, w):
        hw = w.tags.get("highway")
        if hw is None:
            return
        ok = hw in WALKABLE or w.tags.get("foot") in ("yes", "designated") or w.tags.get("bicycle") in ("yes", "designated")
        if not ok or w.tags.get("access") in ("private", "no") or w.tags.get("foot") == "no" and w.tags.get("bicycle") in (None, "no"):
            return
        try:
            pts = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        is_bridge = w.tags.get("bridge") not in (None, "no")
        cells = self.bridge_cells if is_bridge else self.cells
        for (la1, lo1), (la2, lo2) in zip(pts, pts[1:]):
            d = float(haversine_m(la1, lo1, la2, lo2))
            steps = max(1, int(d // 30))
            for i in range(steps + 1):
                t = i / steps
                cells.add(h3.latlng_to_cell(la1 + (la2 - la1) * t, lo1 + (lo2 - lo1) * t, H3_RES))
        if is_bridge and len(pts) > 1:
            self.bridge_lines.append(LineString([(lo, la) for la, lo in pts]))


def main():
    zones = gpd.read_file(RAW / "tlc" / "zones" / "taxi_zones" / "taxi_zones.shp").to_crs(4326)
    zid_col = "LocationID" if "LocationID" in zones else "OBJECTID"
    zones = zones[zones.borough != "EWR"]
    print("zones", len(zones), "area km2", zones.to_crs(2263).area.sum() * 0.0929 / 1e6)

    # 1. candidate land cells (centre inside a zone) with zone id
    cell_zone: dict[str, int] = {}
    cell_boro: dict[str, str] = {}
    for _, z in zones.iterrows():
        geom = z.geometry
        polys = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        for p in polys:
            for c in h3.geo_to_cells(p.__geo_interface__, H3_RES):
                cell_zone[c] = int(z[zid_col])
                cell_boro[c] = z["borough"]
    print("land cells", len(cell_zone))

    # 2. walkable cells from OSM
    h = WayHandler()
    h.apply_file(str(RAW / "osm" / "nyc.osm.pbf"), locations=True)
    print("osm walk cells", len(h.cells), "bridge cells", len(h.bridge_cells))

    land = shapely.union_all(zones.geometry.values)
    bridges = shapely.union_all([shapely.buffer(l, 0.0009) for l in h.bridge_lines]) if h.bridge_lines else None

    tiles = sorted((set(cell_zone) & h.cells) | {c for c in h.bridge_cells if c in cell_zone or bridges is not None})
    # bridge cells outside land are kept only if centre is near a bridge line
    keep = []
    for c in tiles:
        if c in cell_zone:
            keep.append(c)
        else:
            la, lo = h3.cell_to_latlng(c)
            if bridges is not None and shapely.contains_xy(bridges, lo, la):
                keep.append(c)
    tiles = keep
    idx = {c: i for i, c in enumerate(tiles)}
    n = len(tiles)
    ll = np.array([h3.cell_to_latlng(c) for c in tiles], dtype=np.float64)
    print("tiles", n)

    # 3. edges
    src, dst = [], []
    for i, c in enumerate(tiles):
        for nb in h3.grid_ring(c, 1):
            j = idx.get(nb)
            if j is not None and j > i:
                src.append(i); dst.append(j)
    src = np.array(src); dst = np.array(dst)
    mid_lat = (ll[src, 0] + ll[dst, 0]) / 2
    mid_lng = (ll[src, 1] + ll[dst, 1]) / 2
    ok = shapely.contains_xy(land, mid_lng, mid_lat)
    if bridges is not None:
        ok |= shapely.contains_xy(bridges, mid_lng, mid_lat)
    src, dst = src[ok], dst[ok]
    length = haversine_m(ll[src, 0], ll[src, 1], ll[dst, 0], ll[dst, 1]) * WALK_DETOUR
    print("edges", len(src), "dropped (water)", int((~ok).sum()))

    # keep largest connected component (+ anything reasonably big, e.g. islands with ferries)
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    m = coo_matrix((np.ones(len(src)), (src, dst)), shape=(n, n))
    ncomp, lab = connected_components(m, directed=False)
    sizes = np.bincount(lab)
    good = sizes[lab] >= 50
    print("components", ncomp, "keeping tiles", int(good.sum()))
    remap = -np.ones(n, dtype=np.int64)
    remap[good] = np.arange(good.sum())
    tiles = [c for c, g in zip(tiles, good) if g]
    ll = ll[good]
    e_ok = good[src] & good[dst]
    src, dst, length = remap[src[e_ok]], remap[dst[e_ok]], length[e_ok]
    n = len(tiles)

    # CSR (undirected -> both directions)
    a = np.concatenate([src, dst]); b = np.concatenate([dst, src]); L = np.concatenate([length, length])
    order = np.argsort(a, kind="stable")
    a, b, L = a[order], b[order], L[order]
    off = np.zeros(n + 1, dtype=np.int32)
    np.add.at(off, a + 1, 1)
    off = np.cumsum(off).astype(np.int32)

    zone = np.array([cell_zone.get(c, 0) for c in tiles], dtype=np.uint16)
    flag = np.array([(1 if cell_boro.get(c) == "Manhattan" else 0) | (0 if c in cell_zone else 2) for c in tiles], dtype=np.uint8)

    save_bin("tiles_h3.bin", np.array([h3.str_to_int(c) for c in tiles], dtype=np.uint64))
    save_bin("tiles_ll.bin", ll.astype(np.float32))
    save_bin("tiles_zone.bin", zone)
    save_bin("tiles_flag.bin", flag)
    save_bin("graph_off.bin", off)
    save_bin("graph_nbr.bin", b.astype(np.int32))
    save_bin("graph_len.bin", np.minimum(L, 65535).astype(np.uint16))
    np.save(BUILD / "tiles_ll.npy", ll)
    np.save(BUILD / "graph_csr.npy", np.stack([a, b, L]))
    (BUILD / "tiles.txt").write_text("\n".join(tiles))
    save_json("grid_meta.json", {"n": n, "res": H3_RES, "edges": int(len(b))})
    print("done", n, "tiles", len(b), "directed edges")


if __name__ == "__main__":
    main()
