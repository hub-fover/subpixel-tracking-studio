import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile, status

from .jobs import registry
from .feature_refinement import ExtractionIntent, refine_feature
from .reports import multi_report_payload, report_payload
from .scene_registration import register_scene
from .schemas import AnchorCorrespondence, JobStatus, MultiPointJob, MultiPointTrack, PointTrack, RecoveryAnchorsRequest, RecoveryEvent, TrackingJob

app = FastAPI(title="Subpixel Tracking API", version="0.1.0")


@app.post("/api/scene-registration")
async def scene_registration(
    reference: UploadFile = File(...), current: UploadFile = File(...),
    source_width: int = Form(...), source_height: int = Form(...), frame: int = Form(...),
) -> dict:
    if source_width <= 0 or source_height <= 0 or frame < 0:
        raise HTTPException(422, detail={"code": "registration.invalid-source", "recoverable": True})
    reference_data = np.frombuffer(await reference.read(), dtype=np.uint8)
    current_data = np.frombuffer(await current.read(), dtype=np.uint8)
    reference_image = cv2.imdecode(reference_data, cv2.IMREAD_UNCHANGED)
    current_image = cv2.imdecode(current_data, cv2.IMREAD_UNCHANGED)
    if reference_image is None or current_image is None:
        raise HTTPException(400, detail={"code": "registration.decode-failed", "recoverable": True})
    if reference_image.shape[1] != source_width or reference_image.shape[0] != source_height or current_image.shape[1] != source_width or current_image.shape[0] != source_height:
        raise HTTPException(422, detail={"code": "registration.dimension-mismatch", "recoverable": True})
    return register_scene(reference_image, current_image, frame)


@app.post("/api/features/refine")
async def refine_feature_roi(
    patch: UploadFile = File(...), intent: ExtractionIntent = Form(...),
    roi_x: float = Form(...), roi_y: float = Form(...), roi_width: int = Form(...), roi_height: int = Form(...),
    source_width: int = Form(...), source_height: int = Form(...),
) -> dict:
    if roi_width * roi_height > 4_000_000:
        raise HTTPException(413, detail={"code": "refinement.roi-too-large", "recoverable": True})
    if roi_width <= 0 or roi_height <= 0 or roi_x < 0 or roi_y < 0 or roi_x + roi_width > source_width or roi_y + roi_height > source_height:
        raise HTTPException(422, detail={"code": "refinement.invalid-roi", "recoverable": True})
    payload = np.frombuffer(await patch.read(), dtype=np.uint8)
    image = cv2.imdecode(payload, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise HTTPException(400, detail={"code": "refinement.decode-failed", "recoverable": True})
    if image.shape[1] != roi_width or image.shape[0] != roi_height:
        raise HTTPException(422, detail={"code": "refinement.dimension-mismatch", "recoverable": True})
    result = refine_feature(image, intent, (roi_x, roi_y, float(roi_width), float(roi_height)))
    return result.model_dump(mode="json")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/jobs", response_model=JobStatus, status_code=status.HTTP_202_ACCEPTED)
async def create_job(job: TrackingJob) -> JobStatus:
    await registry.submit(job)
    return registry.status(job.id)


@app.post("/api/multi-jobs", response_model=JobStatus, status_code=status.HTTP_202_ACCEPTED)
async def create_multi_job(job: MultiPointJob) -> JobStatus:
    await registry.submit_multi(job)
    return registry.status(job.id)


@app.get("/api/multi-jobs/{job_id}/tracks", response_model=list[MultiPointTrack])
def get_multi_tracks(job_id: str) -> list[MultiPointTrack]:
    record = registry.records.get(job_id)
    if record is None or not isinstance(record.job, MultiPointJob):
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    return record.multi_tracks


@app.get("/api/multi-jobs/{job_id}/reports")
def get_multi_report(job_id: str, format: str = "json") -> Response:
    record = registry.records.get(job_id)
    if record is None or not isinstance(record.job, MultiPointJob):
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    try:
        content, media_type, filename = multi_report_payload(job_id, record.multi_tracks, record.recovery_events, format)
    except ValueError as error:
        raise HTTPException(409, detail={"code": str(error), "recoverable": True, "jobId": job_id}) from error
    return Response(content, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.post("/api/multi-jobs/{job_id}/recovery/anchors", response_model=RecoveryEvent)
def select_recovery_anchors(job_id: str, request: RecoveryAnchorsRequest) -> RecoveryEvent:
    record = registry.records.get(job_id)
    if record is None or not isinstance(record.job, MultiPointJob):
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    record.recovery_anchors = request.anchors
    record.recovery_frame = request.frame
    coverage = _anchor_coverage(request.anchors)
    event = RecoveryEvent(id=f"recovery-{request.frame}", frame=request.frame, kind="anchors-selected", anchorCount=len(request.anchors), coverage=coverage, inlierRatio=1, predictedMedianError=0, reversible=True)
    record.recovery_events.append(event)
    return event


@app.post("/api/multi-jobs/{job_id}/recovery/apply")
def apply_recovery(job_id: str) -> dict:
    record = registry.records.get(job_id)
    if record is None or not isinstance(record.job, MultiPointJob):
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    if len(record.recovery_anchors) < 4:
        raise HTTPException(409, detail={"code": "recovery.too-few-anchors", "recoverable": True, "jobId": job_id})
    coverage = _anchor_coverage(record.recovery_anchors)
    if coverage == 0:
        raise HTTPException(409, detail={"code": "recovery.degenerate-anchors", "recoverable": True, "jobId": job_id})
    if coverage < 0.1:
        raise HTTPException(409, detail={"code": "recovery.low-coverage", "recoverable": True, "jobId": job_id})
    frame = record.recovery_frame or 0
    event = RecoveryEvent(id=f"recovery-applied-{frame}", frame=frame, kind="applied", anchorCount=len(record.recovery_anchors), coverage=coverage, inlierRatio=1, predictedMedianError=0, reversible=True)
    record.recovery_events.append(event)
    return {"status": "applied", "event": event.model_dump(mode="json")}


@app.post("/api/multi-jobs/{job_id}/recovery/rollback")
def rollback_recovery(job_id: str) -> dict:
    record = registry.records.get(job_id)
    if record is None or not isinstance(record.job, MultiPointJob):
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    frame = record.recovery_frame or 0
    event = RecoveryEvent(id=f"recovery-rollback-{frame}", frame=frame, kind="rolled-back", anchorCount=len(record.recovery_anchors), coverage=_anchor_coverage(record.recovery_anchors), inlierRatio=1, predictedMedianError=0, reversible=False)
    record.recovery_events.append(event)
    record.recovery_anchors = []
    return {"status": "rolled-back", "event": event.model_dump(mode="json")}


def _anchor_coverage(anchors: list[AnchorCorrespondence]) -> float:
    if len(anchors) < 3:
        return 0.0
    points = sorted({(anchor.reference.x, anchor.reference.y) for anchor in anchors})
    def cross(origin: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
    lower: list[tuple[float, float]] = []
    upper: list[tuple[float, float]] = []
    for point in points:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    for point in reversed(points):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    hull = lower[:-1] + upper[:-1]
    area = abs(sum(point[0] * hull[(index + 1) % len(hull)][1] - hull[(index + 1) % len(hull)][0] * point[1] for index, point in enumerate(hull))) / 2 if len(hull) >= 3 else 0
    return min(1.0, max(0.0, area / (960 * 600)))


@app.get("/api/jobs/{job_id}", response_model=JobStatus)
def get_job(job_id: str) -> JobStatus:
    try:
        return registry.status(job_id)
    except KeyError as error:
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id}) from error


@app.get("/api/jobs/{job_id}/tracks", response_model=list[PointTrack])
def get_tracks(job_id: str) -> list[PointTrack]:
    if job_id not in registry.records:
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    return registry.records[job_id].tracks


@app.post("/api/jobs/{job_id}/cancel", response_model=JobStatus)
def cancel_job(job_id: str) -> JobStatus:
    if job_id not in registry.records:
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    return registry.cancel(job_id)


@app.post("/api/jobs/{job_id}/reports")
def create_report(job_id: str, format: str = "pdf") -> Response:
    if job_id not in registry.records:
        raise HTTPException(404, detail={"code": "job.not-found", "recoverable": False, "jobId": job_id})
    try:
        content, media_type, filename = report_payload(job_id, registry.records[job_id].tracks, format)
    except ValueError as error:
        raise HTTPException(409, detail={"code": str(error), "recoverable": True, "jobId": job_id}) from error
    return Response(content, media_type=media_type, headers={"Content-Disposition": f'attachment; filename="{filename}"'})
