"""Shared paths and helpers for the pipeline."""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
BUILD = ROOT / "data" / "build"          # intermediate (python-only)
OUT = ROOT / "web" / "public" / "data"   # shipped to the browser
BUILD.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

H3_RES = 10
WALK_MPS = 1.3          # walking speed, m/s
WALK_DETOUR = 1.2       # applied to every hex edge (street-grid detour vs straight line)
MAX_ACCESS_WALK_S = 20 * 60
MAX_EGRESS_WALK_S = 15 * 60
K_STOPS_PER_TILE = 16
K_DOCKS_PER_TILE = 4


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371008.8
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = p2 - p1
    dl = np.radians(np.asarray(lng2) - np.asarray(lng1))
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def save_bin(name: str, arr: np.ndarray) -> None:
    arr = np.ascontiguousarray(arr)
    (OUT / name).write_bytes(arr.tobytes())


def save_json(name: str, obj, out_dir: Path = OUT) -> None:
    (out_dir / name).write_text(json.dumps(obj, separators=(",", ":")))


def load_fares() -> dict:
    return json.loads((ROOT / "pipeline" / "fares.json").read_text())
