from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np

WORKSPACE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKSPACE / "services" / "api"))
from app.algorithms import detect_natural_candidates, register_scene_sift


IMAGE_SUFFIXES = {".bmp", ".jpg", ".jpeg", ".png", ".tif", ".tiff"}


def read_image(path: Path, max_dimension: int = 1600) -> np.ndarray | None:
    data = np.fromfile(path, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE) if data.size else None
    if image is not None and max(image.shape) > max_dimension:
        scale = max_dimension / max(image.shape)
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return image


def evaluate_directory(source: str | Path, max_pairs: int = 20) -> dict[str, Any]:
    root = Path(source)
    images = sorted(path for path in root.rglob("*") if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES and "_results" not in str(path.parent))
    by_directory: dict[Path, list[Path]] = {}
    for image in images:
        by_directory.setdefault(image.parent, []).append(image)
    metrics: list[dict[str, Any]] = []
    for directory, group in by_directory.items():
        if len(group) < 2 or len(metrics) >= max_pairs:
            continue
        reference_path, current_path = group[0], group[-1]
        reference, current = read_image(reference_path), read_image(current_path)
        if reference is None or current is None:
            continue
        registration = register_scene_sift(reference, current)
        candidates = detect_natural_candidates(reference, limit=100)
        metrics.append({"group": str(directory.relative_to(root)) if directory != root else ".", "reference": reference_path.name, "current": current_path.name, "candidateCount": len(candidates), **registration})
    return {"source": str(root.resolve()), "imageCount": len(images), "groupCount": len(by_directory), "pairMetrics": metrics, "thresholds": {"inlierRatio": .35, "medianReprojectionErrorPx": 3, "naturalCandidateLimit": 100}}


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only sample replay evaluation")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-pairs", type=int, default=20)
    args = parser.parse_args()
    result = evaluate_directory(args.source, args.max_pairs)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"imageCount": result["imageCount"], "pairCount": len(result["pairMetrics"]), "output": str(args.output.resolve())}, ensure_ascii=False))


if __name__ == "__main__":
    main()
