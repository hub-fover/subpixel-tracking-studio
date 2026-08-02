import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.main import app


def _encoded(image: np.ndarray) -> bytes:
    ok, data = cv2.imencode(".png", image)
    assert ok
    return data.tobytes()


def _scene() -> np.ndarray:
    image = np.zeros((240, 320), np.uint8)
    for y in range(20, 220, 24):
        for x in range(20, 300, 28):
            cv2.circle(image, (x, y), 5, 180 + ((x + y) % 70), -1)
    cv2.putText(image, "SUBPIXEL", (55, 130), cv2.FONT_HERSHEY_SIMPLEX, 1.1, 255, 2)
    cv2.rectangle(image, (35, 35), (285, 205), 220, 2)
    return image


def test_scene_registration_returns_original_pixel_homography() -> None:
    reference = _scene()
    matrix = cv2.getRotationMatrix2D((160, 120), 17, 1.03)
    matrix[:, 2] += (14, -9)
    current = cv2.warpAffine(reference, matrix, (320, 240))
    response = TestClient(app).post(
        "/api/scene-registration",
        files={
            "reference": ("reference.png", _encoded(reference), "image/png"),
            "current": ("current.png", _encoded(current), "image/png"),
        },
        data={"source_width": "320", "source_height": "240", "frame": "5"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["frame"] == 5
    assert body["accepted"] is True
    assert body["method"] in {"sift-ransac", "orb-ransac"}
    assert len(body["transform"]["matrix"]) == 9
    assert body["inlierRatio"] >= 0.35


def test_scene_registration_rejects_blank_images_with_structured_reason() -> None:
    blank = np.zeros((80, 80), np.uint8)
    response = TestClient(app).post(
        "/api/scene-registration",
        files={"reference": ("r.png", _encoded(blank), "image/png"), "current": ("c.png", _encoded(blank), "image/png")},
        data={"source_width": "80", "source_height": "80", "frame": "1"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is False
    assert body["reason"] in {"insufficient-matches", "insufficient-inliers"}
