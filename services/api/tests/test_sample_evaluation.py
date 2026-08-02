import cv2
import numpy as np

from scripts.evaluate_samples import evaluate_directory


def test_sample_evaluation_writes_pair_metrics_without_modifying_sources(tmp_path) -> None:
    image = np.zeros((180, 220), dtype=np.uint8)
    cv2.putText(image, "TEST", (20, 100), cv2.FONT_HERSHEY_SIMPLEX, 2, 255, 3)
    cv2.imwrite(str(tmp_path / "a.png"), image)
    cv2.imwrite(str(tmp_path / "b.png"), image)
    before = (tmp_path / "a.png").read_bytes()
    result = evaluate_directory(tmp_path, max_pairs=1)
    assert result["imageCount"] == 2
    assert result["pairMetrics"][0]["inlierRatio"] >= 0.35
    assert (tmp_path / "a.png").read_bytes() == before
