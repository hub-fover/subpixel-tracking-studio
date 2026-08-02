from enum import Enum
from math import isfinite
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class FeatureType(str, Enum):
    circle = "circle"
    blob = "blob"
    crosshair = "crosshair"
    diagonal = "diagonal"
    speckle = "speckle"
    natural_keypoint = "natural-keypoint"


class ExtractionIntent(str, Enum):
    circle_center = "circle-center"
    crosshair_center = "crosshair-center"
    diagonal_center = "diagonal-center"
    corner = "corner"
    blob_center = "blob-center"
    speckle_center = "speckle-center"
    natural_keypoint = "natural-keypoint"


class Point(BaseModel):
    x: float
    y: float

    @model_validator(mode="after")
    def finite(self) -> "Point":
        if not isfinite(self.x) or not isfinite(self.y):
            raise ValueError("coordinates must be finite")
        return self


class Roi(BaseModel):
    x: float
    y: float
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class EllipseGeometry(BaseModel):
    kind: Literal["ellipse"] = "ellipse"
    center: Point
    majorAxis: float = Field(gt=0)
    minorAxis: float = Field(gt=0)
    angleDeg: float
    edgeCoverage: float = Field(ge=0, le=1)
    inlierCount: int = Field(ge=0)


class LineSegment(BaseModel):
    start: Point
    end: Point


class LinesGeometry(BaseModel):
    kind: Literal["lines"] = "lines"
    line1: LineSegment
    line2: LineSegment
    angleDeg: float = Field(ge=0, le=180)
    support1: float = Field(ge=0, le=1)
    support2: float = Field(ge=0, le=1)
    widthCv: float | None = Field(default=None, ge=0)


class CornerGeometry(BaseModel):
    kind: Literal["corner"] = "corner"
    point: Point
    response: float = Field(ge=0)
    uniquenessRatio: float = Field(ge=1)


class FeatureRefinement(BaseModel):
    accepted: bool
    intent: ExtractionIntent
    roi: Roi
    point: Point | None
    confidence: float = Field(ge=0, le=1)
    residualPx: float | None = Field(default=None, ge=0)
    gates: dict[str, bool]
    reason: str | None = None
    geometry: EllipseGeometry | LinesGeometry | CornerGeometry | None = Field(default=None, discriminator="kind")


class FrameRange(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    sampleRate: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_order(self) -> "FrameRange":
        if self.end < self.start:
            raise ValueError("end must be greater than or equal to start")
        return self


class TrackingJob(BaseModel):
    id: str = Field(min_length=1)
    mode: Literal["local", "server"]
    source: dict[str, str]
    frameRange: FrameRange
    roi: Roi
    model: dict[str, Any]
    calibration: dict[str, Any] | None = None
    exports: list[Literal["csv", "json", "xlsx", "pdf", "images", "video"]] = Field(default_factory=list)


class PointSeed(BaseModel):
    pointId: str = Field(min_length=1)
    click: Point
    snapped: Point
    roi: Roi
    groupId: str = Field(default="default", min_length=1)
    candidateScore: float = Field(ge=0, le=1)
    model: FeatureType
    selectionMethod: Literal["roi", "click", "import"] | None = None
    intent: ExtractionIntent | None = None
    geometry: EllipseGeometry | LinesGeometry | CornerGeometry | None = Field(default=None, discriminator="kind")
    quality: dict[str, Any] | None = None
    template: dict[str, Any] | None = None


class LearnedRelocationConfig(BaseModel):
    enabled: bool = False
    backend: Literal["superpoint-lightglue", "sift-fallback"] = "sift-fallback"


class MultiPointJob(BaseModel):
    id: str = Field(min_length=1)
    mode: Literal["local", "server"]
    source: dict[str, str]
    frameRange: FrameRange
    seeds: list[PointSeed] = Field(default_factory=list, max_length=100)
    snapRadiusPx: float = Field(default=12, gt=0)
    sceneRegistrationEvery: int = Field(default=5, gt=0)
    learnedRelocation: LearnedRelocationConfig = Field(default_factory=LearnedRelocationConfig)
    exports: list[Literal["csv", "json", "xlsx", "pdf", "images", "video"]] = Field(default_factory=list)


class MultiPointTrack(BaseModel):
    pointId: str = Field(min_length=1)
    frame: int = Field(ge=0)
    timestampMs: float = Field(ge=0)
    predicted: Point
    refined: Point
    model: FeatureType
    confidence: float = Field(ge=0, le=1)
    residual: float = Field(ge=0)
    flowErrorForwardBackward: float | None = Field(default=None, ge=0)
    ncc: float | None = Field(default=None, ge=-1, le=1)
    descriptorDistance: float | None = Field(default=None, ge=0)
    epipolarError: float | None = Field(default=None, ge=0)
    state: Literal["valid", "suspect", "lost", "reviewed", "paused"]
    relocationMethod: Literal["feature-refine", "klt", "local-correlation", "local-affine", "orb", "sift", "manual", "none"] = "none"


class FrameRegistration(BaseModel):
    frame: int = Field(ge=0)
    method: Literal["sift-ransac", "orb-ransac", "homography", "none"]
    inlierCount: int = Field(ge=0)
    matchCount: int = Field(ge=0)
    inlierRatio: float = Field(ge=0, le=1)
    medianReprojectionError: float = Field(ge=0)
    p95LatencyMs: float | None = Field(default=None, ge=0)
    transform: dict[str, Any] | None = None
    accepted: bool = True
    reason: str | None = None


class AnchorCorrespondence(BaseModel):
    pointId: str = Field(min_length=1)
    reference: Point
    current: Point
    confidence: float = Field(ge=0, le=1)


class RecoveryAnchorsRequest(BaseModel):
    frame: int = Field(ge=0)
    anchors: list[AnchorCorrespondence] = Field(min_length=4, max_length=12)


class RecoveryEvent(BaseModel):
    id: str = Field(min_length=1)
    frame: int = Field(ge=0)
    kind: Literal["requested", "anchors-selected", "applied", "rolled-back", "rejected"]
    anchorCount: int = Field(ge=0)
    coverage: float = Field(ge=0, le=1)
    inlierRatio: float = Field(ge=0, le=1)
    predictedMedianError: float = Field(ge=0)
    reversible: bool
    message: str | None = None


class PointTrack(BaseModel):
    frame: int = Field(ge=0)
    timestampMs: float = Field(ge=0)
    x: float
    y: float
    z: float | None = None
    model: FeatureType
    residual: float = Field(ge=0)
    confidence: float = Field(ge=0, le=1)
    state: Literal["valid", "suspect", "lost", "reviewed"]
    durationMs: float = Field(ge=0)

    @model_validator(mode="after")
    def finite_coordinates(self) -> "PointTrack":
        if not all(isfinite(value) for value in (self.x, self.y) if value is not None):
            raise ValueError("coordinates must be finite")
        return self


class JobStatus(BaseModel):
    jobId: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    error: dict[str, Any] | None = None
