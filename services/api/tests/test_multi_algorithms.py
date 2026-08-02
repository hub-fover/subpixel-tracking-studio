import numpy as np

from app.algorithms import detect_natural_candidates, register_scene_sift, validate_natural_identity


def test_natural_candidate_scoring_returns_spatially_distinct_points() -> None:
    image = np.zeros((160, 200), dtype=np.uint8)
    for x, y in ((30, 40), (150, 50), (80, 120)):
        image[y - 3:y + 4, x - 3:x + 4] = 255
    candidates = detect_natural_candidates(image, limit=10)
    assert candidates
    assert all(0 <= item["score"] <= 1 for item in candidates)
    assert len({(item["x"], item["y"]) for item in candidates}) == len(candidates)


def test_scene_registration_uses_sift_ransac_and_identity_gates_are_strict() -> None:
    image = np.zeros((220, 220), dtype=np.uint8)
    cv2 = __import__("cv2")
    cv2.putText(image, "SIFT", (30, 120), cv2.FONT_HERSHEY_SIMPLEX, 2, 255, 3)
    result = register_scene_sift(image, image)
    assert result["method"] == "sift-ransac"
    assert result["inlierRatio"] >= 0.35
    assert validate_natural_identity(1.0, 0.8, 1.0, 0.7)["accepted"] is True
    assert validate_natural_identity(1.6, 0.8, 1.0, 0.7)["accepted"] is False
