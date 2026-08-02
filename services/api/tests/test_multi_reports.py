from fastapi.testclient import TestClient

from app.main import app


def test_multi_report_endpoint_returns_point_ids_and_recovery_events() -> None:
    client = TestClient(app)
    job_id = "multi-report-1"
    client.post("/api/multi-jobs", json={"id": job_id, "mode": "local", "source": {"kind": "image-sequence", "name": "frames"}, "frameRange": {"start": 0, "end": 1, "sampleRate": 1}, "seeds": [], "exports": ["json"]})
    response = client.get(f"/api/multi-jobs/{job_id}/reports?format=json")
    assert response.status_code == 200
    assert response.json()["jobId"] == job_id
    assert "tracks" in response.json()
