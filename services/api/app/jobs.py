import asyncio
from dataclasses import dataclass, field

from .schemas import AnchorCorrespondence, JobStatus, MultiPointJob, MultiPointTrack, PointTrack, RecoveryEvent, TrackingJob


@dataclass
class JobRecord:
    job: TrackingJob | MultiPointJob
    status: str = "queued"
    tracks: list[PointTrack] = field(default_factory=list)
    error: dict | None = None
    multi_tracks: list[MultiPointTrack] = field(default_factory=list)
    recovery_anchors: list[AnchorCorrespondence] = field(default_factory=list)
    recovery_frame: int | None = None
    recovery_events: list[RecoveryEvent] = field(default_factory=list)


class JobRegistry:
    def __init__(self) -> None:
        self.records: dict[str, JobRecord] = {}

    async def submit(self, job: TrackingJob) -> JobRecord:
        record = JobRecord(job=job)
        self.records[job.id] = record
        asyncio.create_task(self._run(record))
        return record

    async def submit_multi(self, job: MultiPointJob) -> JobRecord:
        record = JobRecord(job=job)
        self.records[job.id] = record
        asyncio.create_task(self._run(record))
        return record

    async def _run(self, record: JobRecord) -> None:
        record.status = "running"
        await asyncio.sleep(0)
        if record.status != "cancelled":
            record.status = "completed"

    def status(self, job_id: str) -> JobStatus:
        record = self.records[job_id]
        return JobStatus(jobId=job_id, status=record.status, error=record.error)

    def cancel(self, job_id: str) -> JobStatus:
        self.records[job_id].status = "cancelled"
        return self.status(job_id)


registry = JobRegistry()
