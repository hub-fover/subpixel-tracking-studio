from fastapi.testclient import TestClient

from app.main import app


def seed(point_id: str, x: float, y: float) -> dict:
    return {
        "pointId": point_id,
        "click": {"x": x, "y": y},
        "snapped": {"x": x, "y": y},
        "roi": {"x": x - 8, "y": y - 8, "width": 16, "height": 16},
        "groupId": "natural",
        "candidateScore": 0.9,
        "model": "natural-keypoint",
    }


def test_multi_job_tracks_and_recovery_flow() -> None:
    client = TestClient(app)
    job_id = "multi-api-1"
    response = client.post("/api/multi-jobs", json={
        "id": job_id,
        "mode": "local",
        "source": {"kind": "image-sequence", "name": "frames"},
        "frameRange": {"start": 0, "end": 10, "sampleRate": 1},
        "seeds": [seed("p-1", 20, 20), seed("p-2", 100, 40)],
        "snapRadiusPx": 12,
        "sceneRegistrationEvery": 5,
        "exports": ["json"],
    })
    assert response.status_code == 202
    assert response.json()["jobId"] == job_id
    assert client.get(f"/api/multi-jobs/{job_id}/tracks").json() == []
    anchors = [
        {"pointId": "p-1", "reference": {"x": 20, "y": 20}, "current": {"x": 24, "y": 25}, "confidence": 0.95},
        {"pointId": "p-2", "reference": {"x": 100, "y": 40}, "current": {"x": 104, "y": 45}, "confidence": 0.95},
        {"pointId": "p-3", "reference": {"x": 400, "y": 40}, "current": {"x": 404, "y": 45}, "confidence": 0.95},
        {"pointId": "p-4", "reference": {"x": 400, "y": 400}, "current": {"x": 404, "y": 405}, "confidence": 0.95},
    ]
    assert client.post(f"/api/multi-jobs/{job_id}/recovery/anchors", json={"frame": 4, "anchors": anchors}).status_code == 200
    applied = client.post(f"/api/multi-jobs/{job_id}/recovery/apply")
    assert applied.status_code == 200
    assert applied.json()["status"] == "applied"
    rolled_back = client.post(f"/api/multi-jobs/{job_id}/recovery/rollback")
    assert rolled_back.status_code == 200
    assert rolled_back.json()["status"] == "rolled-back"


def test_recovery_rejects_collinear_anchors() -> None:
    client = TestClient(app)
    job_id = "multi-api-degenerate"
    client.post("/api/multi-jobs", json={"id": job_id, "mode": "local", "source": {"kind": "image-sequence", "name": "frames"}, "frameRange": {"start": 0, "end": 1, "sampleRate": 1}, "seeds": [], "exports": []})
    anchors = [{"pointId": f"p-{index}", "reference": {"x": index * 100, "y": index * 100}, "current": {"x": index * 100 + 2, "y": index * 100 + 3}, "confidence": .9} for index in range(4)]
    client.post(f"/api/multi-jobs/{job_id}/recovery/anchors", json={"frame": 1, "anchors": anchors})
    response = client.post(f"/api/multi-jobs/{job_id}/recovery/apply")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "recovery.degenerate-anchors"
