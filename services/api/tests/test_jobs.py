from fastapi.testclient import TestClient

from app.main import app


JOB = {"id": "job-api-1", "mode": "server", "source": {"kind": "image-sequence", "name": "frames"}, "frameRange": {"start": 0, "end": 2, "sampleRate": 1}, "roi": {"x": 1, "y": 2, "width": 20, "height": 20}, "model": {"type": "circle", "locked": True, "params": {}}, "calibration": None, "exports": ["json"]}


def test_job_lifecycle() -> None:
    client = TestClient(app)
    response = client.post("/api/jobs", json=JOB)
    assert response.status_code == 202
    assert response.json()["jobId"] == "job-api-1"
    assert client.get("/api/jobs/job-api-1").status_code == 200
    assert client.get("/api/jobs/job-api-1/tracks").json() == []
