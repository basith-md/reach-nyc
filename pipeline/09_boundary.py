"""Outer border of New York City (five boroughs) for the map, from the TLC taxi zones.
Output: web/public/data/nyc_boundary.geojson (outline rings only)
"""
import json

import geopandas as gpd
import shapely

from common import RAW, OUT

z = gpd.read_file(RAW / "tlc" / "zones" / "taxi_zones" / "taxi_zones.shp")
z = z[z.borough != "EWR"].to_crs(2263)
city = shapely.union_all(z.geometry.buffer(40).values).buffer(-40)          # close tiny slivers between zones (feet)
city = city.buffer(-250).buffer(250)                                          # shave off piers and thin spits: outer edge only
city = gpd.GeoSeries([city], crs=2263).simplify(80).to_crs(4326).iloc[0]
polys = list(city.geoms) if city.geom_type == "MultiPolygon" else [city]
polys = [p for p in polys if p.area > 2e-4]                                   # keep only the main landmasses (~2 km2+)
rings = [[[round(x, 5), round(y, 5)] for x, y in p.exterior.coords] for p in polys]
(OUT / "nyc_boundary.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": [
    {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": rings}, "properties": {}}]}, separators=(",", ":")))
print("rings", len(rings), "points", sum(len(r) for r in rings))
