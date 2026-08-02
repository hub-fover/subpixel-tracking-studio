import csv
import json

from app.imports import load_legacy_project


def test_load_legacy_project_preserves_track_model_and_method(tmp_path) -> None:
    (tmp_path / "project.json").write_text(json.dumps({"name": "legacy"}), encoding="utf-8")
    (tmp_path / "marker_registrations.json").write_text(json.dumps([{"track_id": 7, "model": "crosshair"}]), encoding="utf-8")
    (tmp_path / "registrations.json").write_text(json.dumps([{"frame": 1, "method": "sift"}]), encoding="utf-8")
    with (tmp_path / "tracks.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=["track_id", "frame", "x", "y", "model", "method"]); writer.writeheader(); writer.writerow({"track_id": 7, "frame": 1, "x": 10, "y": 20, "model": "crosshair", "method": "legacy-refine"})
    imported = load_legacy_project(tmp_path)
    assert imported["tracks"][0]["track_id"] == "7"
    assert imported["tracks"][0]["model"] == "crosshair"
    assert imported["tracks"][0]["method"] == "legacy-refine"
