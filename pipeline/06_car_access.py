"""Where can a cab / Uber actually pick up or drop off?

A tile is car-accessible if it contains a street a car may stop on (no highways, nothing closed to
motor vehicles, e.g. Central Park drives). Every other tile gets its nearest car-accessible tile + walk time.
Outputs: car_tile.bin int32[N] (nearest car-accessible tile, -1 if none), car_walk_s.bin uint16[N]
"""
import h3
import numpy as np
import osmium
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from common import RAW, BUILD, H3_RES, WALK_MPS, haversine_m, save_bin

STOPPABLE = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link",
             "unclassified", "residential", "living_street", "service"}
NO = {"no", "private", "delivery", "destination_no"}


class Roads(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.cells: set[str] = set()

    def way(self, w):
        if w.tags.get("highway") not in STOPPABLE:
            return
        t = w.tags
        if t.get("access") in NO or t.get("motor_vehicle") in NO or t.get("motorcar") in NO or t.get("vehicle") in NO:
            return
        if t.get("service") in ("parking_aisle", "drive-through"):
            return
        try:
            pts = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        for (a1, o1), (a2, o2) in zip(pts, pts[1:]):
            steps = max(1, int(float(haversine_m(a1, o1, a2, o2)) // 30))
            for i in range(steps + 1):
                f = i / steps
                self.cells.add(h3.latlng_to_cell(a1 + (a2 - a1) * f, o1 + (o2 - o1) * f, H3_RES))


def main():
    tiles = (BUILD / "tiles.txt").read_text().split("\n")
    n = len(tiles)
    a, b, L = np.load(BUILD / "graph_csr.npy")
    G = csr_matrix((L, (a.astype(int), b.astype(int))), shape=(n, n))
    r = Roads()
    r.apply_file(str(RAW / "osm" / "nyc.osm.pbf"), locations=True)
    car_ok = np.array([c in r.cells for c in tiles])
    src = np.nonzero(car_ok)[0]
    D, _, origin = dijkstra(G, directed=False, indices=src, min_only=True, return_predecessors=True)
    car_tile = np.where(np.isfinite(D), origin, -1).astype(np.int32)
    walk_s = np.where(np.isfinite(D), np.minimum(D / WALK_MPS, 65535), 0).astype(np.uint16)
    save_bin("car_tile.bin", car_tile)
    save_bin("car_walk_s.bin", walk_s)
    far = (walk_s > 300).sum()
    print(f"car-accessible tiles {car_ok.sum()}/{n}; tiles >5 min walk from a drop-off point: {far}")


if __name__ == "__main__":
    main()
