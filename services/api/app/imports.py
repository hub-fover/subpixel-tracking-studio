import csv
import json
from pathlib import Path
from typing import Any


def load_legacy_project(directory: str | Path) -> dict[str, Any]:
    root = Path(directory)
    if not root.is_dir():
        raise ValueError("import.directory-not-found")

    def read_json(name: str, default: Any) -> Any:
        path = root / name
        return json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else default

    tracks_path = root / "tracks.csv"
    tracks: list[dict[str, str]] = []
    if tracks_path.exists():
        with tracks_path.open("r", encoding="utf-8-sig", newline="") as stream:
            tracks = list(csv.DictReader(stream))
    return {
        "project": read_json("project.json", {}),
        "markerRegistrations": read_json("marker_registrations.json", []),
        "registrations": read_json("registrations.json", []),
        "tracks": tracks,
        "sourceDirectory": str(root.resolve()),
    }
