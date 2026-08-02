import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.feature_refinement import ExtractionIntent, refine_feature
from app.main import app


def _encoded(image: np.ndarray) -> bytes:
    ok, data = cv2.imencode(".png", image)
    assert ok
    return data.tobytes()


def test_subpixel_ellipse_center_and_origin_mapping() -> None:
    image = np.zeros((72, 80), np.uint8)
    expected = (39.35, 34.7)
    cv2.ellipse(image, (round(expected[0] * 16), round(expected[1] * 16)),
                (round(16.2 * 16), round(11.4 * 16)), 21, 0, 360, 255, 2,
                lineType=cv2.LINE_AA, shift=4)
    result = refine_feature(image, ExtractionIntent.circle_center, (120.0, 75.0, 80.0, 72.0))
    assert result.accepted, result.reason
    assert result.geometry is not None and result.geometry.kind == "ellipse"
    assert np.hypot(result.point.x - (120 + expected[0]), result.point.y - (75 + expected[1])) <= 0.1


def test_crosshair_and_diagonal_centers() -> None:
    for intent, angles in ((ExtractionIntent.crosshair_center, (0, 90)),
                           (ExtractionIntent.diagonal_center, (33, 121))):
        image = np.zeros((96, 96), np.uint8)
        expected = np.array([47.3, 45.65])
        yy, xx = np.indices(image.shape, dtype=np.float32)
        for angle in angles:
            direction = np.array([np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))])
            normal = np.array([-direction[1], direction[0]])
            distance = (xx - expected[0]) * normal[0] + (yy - expected[1]) * normal[1]
            image = np.maximum(image, np.round(255 * np.exp(-(distance ** 2) / (2 * 1.35 ** 2))).astype(np.uint8))
        result = refine_feature(image, intent, (10.0, 20.0, 96.0, 96.0))
        assert result.accepted, result.reason
        assert np.linalg.norm(np.array([result.point.x, result.point.y]) - expected - (10, 20)) <= 0.1


def test_corner_refines_subpixel_location() -> None:
    expected = np.array([31.5, 29.75])
    yy, xx = np.indices((64, 64), dtype=np.float32)
    image = (255 / (1 + np.exp(-(xx - expected[0]) * 3)) / (1 + np.exp(-(yy - expected[1]) * 3))).astype(np.uint8)
    result = refine_feature(image, ExtractionIntent.corner, (0.0, 0.0, 64.0, 64.0))
    assert result.accepted, result.reason
    assert np.linalg.norm(np.array([result.point.x, result.point.y]) - expected) <= 0.15


def test_blank_and_partial_circle_are_rejected_without_center_fallback() -> None:
    blank = refine_feature(np.zeros((48, 48), np.uint8), ExtractionIntent.circle_center, (0, 0, 48, 48))
    assert not blank.accepted and blank.point is None
    partial = np.zeros((48, 48), np.uint8)
    cv2.circle(partial, (2, 24), 15, 255, 2, cv2.LINE_AA)
    result = refine_feature(partial, ExtractionIntent.circle_center, (0, 0, 48, 48))
    assert not result.accepted and not result.gates["completeGeometry"]


def test_refinement_api_decodes_patch_and_maps_original_origin() -> None:
    image = np.zeros((64, 64), np.uint8)
    cv2.circle(image, (round(30.25 * 16), round(32.4 * 16)), 12 * 16, 255, 2, cv2.LINE_AA, shift=4)
    response = TestClient(app).post("/api/features/refine", files={"patch": ("roi.png", _encoded(image), "image/png")}, data={
        "intent": "circle-center", "roi_x": "500", "roi_y": "700", "roi_width": "64", "roi_height": "64",
        "source_width": "1920", "source_height": "1080"
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["accepted"]
    assert abs(body["point"]["x"] - 530.25) <= 0.1
    assert abs(body["point"]["y"] - 732.4) <= 0.1


def test_refinement_api_rejects_decode_dimension_and_area_errors() -> None:
    client = TestClient(app)
    base = {"intent": "circle-center", "roi_x": "0", "roi_y": "0", "roi_width": "10", "roi_height": "10",
            "source_width": "100", "source_height": "100"}
    assert client.post("/api/features/refine", files={"patch": ("x", b"not-image")}, data=base).status_code == 400
    tiny = np.zeros((10, 10), np.uint8)
    mismatch = {**base, "roi_width": "11"}
    assert client.post("/api/features/refine", files={"patch": ("x.png", _encoded(tiny))}, data=mismatch).status_code == 422
    too_large = {**base, "roi_width": "2001", "roi_height": "2000"}
    assert client.post("/api/features/refine", files={"patch": ("x.png", _encoded(tiny))}, data=too_large).status_code == 413
