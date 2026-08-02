import { z } from "zod";

const FeatureModelTypeSchema = z.enum([
  "circle",
  "blob",
  "crosshair",
  "diagonal",
  "speckle",
  "natural-keypoint"
]);

const ExportFormatSchema = z.enum([
  "csv",
  "json",
  "xlsx",
  "pdf",
  "images",
  "video"
]);

export const RoiSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive()
});

export const PointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

export const ExtractionIntentSchema = z.enum([
  "circle-center", "crosshair-center", "diagonal-center", "corner",
  "blob-center", "speckle-center", "natural-keypoint"
]);

const EllipseGeometrySchema = z.object({
  kind: z.literal("ellipse"), center: PointSchema,
  majorAxis: z.number().positive(), minorAxis: z.number().positive(), angleDeg: z.number().finite(),
  edgeCoverage: z.number().min(0).max(1), inlierCount: z.number().int().nonnegative()
});
const LineSchema = z.object({ start: PointSchema, end: PointSchema });
const LinesGeometrySchema = z.object({
  kind: z.literal("lines"), line1: LineSchema, line2: LineSchema,
  angleDeg: z.number().min(0).max(180), support1: z.number().min(0).max(1),
  support2: z.number().min(0).max(1), widthCv: z.number().nonnegative().nullable()
});
const CornerGeometrySchema = z.object({
  kind: z.literal("corner"), point: PointSchema,
  response: z.number().nonnegative(), uniquenessRatio: z.number().min(1)
});
export const RefinementGeometrySchema = z.discriminatedUnion("kind", [
  EllipseGeometrySchema, LinesGeometrySchema, CornerGeometrySchema
]);
export const FeatureRefinementSchema = z.object({
  accepted: z.boolean(), intent: ExtractionIntentSchema, roi: RoiSchema,
  point: PointSchema.nullable(), confidence: z.number().min(0).max(1),
  residualPx: z.number().nonnegative().nullable(), gates: z.record(z.boolean()),
  reason: z.string().nullable(), geometry: RefinementGeometrySchema.nullable()
});
export const FeatureDraftSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["selecting", "refining", "ready", "invalid"]),
  intent: ExtractionIntentSchema,
  roi: RoiSchema,
  revision: z.number().int().nonnegative(),
  refinement: FeatureRefinementSchema.nullable().optional()
});

export const PointSeedSchema = z.object({
  pointId: z.string().min(1),
  click: PointSchema,
  snapped: PointSchema,
  roi: RoiSchema,
  groupId: z.string().min(1).default("default"),
  candidateScore: z.number().min(0).max(1),
  model: FeatureModelTypeSchema,
  selectionMethod: z.enum(["roi", "click", "import"]).optional(),
  intent: ExtractionIntentSchema.optional(),
  geometry: RefinementGeometrySchema.nullable().optional(),
  quality: z.object({
    confidence: z.number().min(0).max(1), residualPx: z.number().nonnegative().nullable(),
    gates: z.record(z.boolean())
  }).optional(),
  template: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    levels: z.number().int().positive().default(1),
    descriptor: z.array(z.number().finite()).default([]),
    gradientTemplate: z.array(z.number().finite()).default([]),
    topology: z.array(z.string()).default([])
  }).optional()
});

export const TrackingJobSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["local", "server"]),
  source: z.object({
    kind: z.enum(["image-sequence", "video", "camera"]),
    name: z.string().min(1)
  }),
  frameRange: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      sampleRate: z.number().positive()
    })
    .refine(({ start, end }) => end >= start, {
      message: "frameRange.end must be greater than or equal to frameRange.start",
      path: ["end"]
    }),
  roi: RoiSchema,
  model: z.object({
    type: FeatureModelTypeSchema,
    locked: z.boolean(),
    params: z.record(z.number())
  }),
  calibration: z
    .object({
      pixelSize: z.number().positive(),
      unit: z.string().min(1)
    })
    .nullable(),
  exports: z.array(ExportFormatSchema)
});

export const PointTrackSchema = z.object({
  frame: z.number().int().nonnegative(),
  timestampMs: z.number().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite().optional(),
  model: FeatureModelTypeSchema,
  residual: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  state: z.enum(["valid", "suspect", "lost", "reviewed"]),
  durationMs: z.number().nonnegative()
});

export const MultiPointJobSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(["local", "server"]),
  source: z.object({ kind: z.enum(["image-sequence", "video", "camera"]), name: z.string().min(1) }),
  frameRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), sampleRate: z.number().positive() })
    .refine(({ start, end }) => end >= start, { message: "frameRange.end must be greater than or equal to start", path: ["end"] }),
  seeds: z.array(PointSeedSchema).max(100),
  snapRadiusPx: z.number().positive().default(12),
  sceneRegistrationEvery: z.number().int().positive().default(5),
  learnedRelocation: z.object({ enabled: z.boolean(), backend: z.enum(["superpoint-lightglue", "sift-fallback"]) }).default({ enabled: false, backend: "sift-fallback" }),
  exports: z.array(ExportFormatSchema).default([])
});

export const MultiPointTrackSchema = z.object({
  pointId: z.string().min(1),
  frame: z.number().int().nonnegative(),
  timestampMs: z.number().nonnegative(),
  predicted: PointSchema,
  refined: PointSchema,
  model: FeatureModelTypeSchema,
  confidence: z.number().min(0).max(1),
  residual: z.number().nonnegative(),
  flowErrorForwardBackward: z.number().nonnegative().nullable().default(null),
  ncc: z.number().min(-1).max(1).nullable().default(null),
  descriptorDistance: z.number().nonnegative().nullable().default(null),
  epipolarError: z.number().nonnegative().nullable().default(null),
  state: z.enum(["valid", "suspect", "lost", "reviewed", "paused"]),
  relocationMethod: z.enum(["feature-refine", "klt", "local-correlation", "local-affine", "orb", "sift", "manual", "none"]).default("none")
});

export const FrameRegistrationSchema = z.object({
  frame: z.number().int().nonnegative(),
  method: z.enum(["sift-ransac", "orb-ransac", "homography", "none"]),
  inlierCount: z.number().int().nonnegative(),
  matchCount: z.number().int().nonnegative(),
  inlierRatio: z.number().min(0).max(1),
  medianReprojectionError: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative().optional(),
  transform: z.object({ kind: z.enum(["homography", "affine"]), matrix: z.array(z.number().finite()).length(9) }).optional(),
  accepted: z.boolean().optional(),
  reason: z.string().nullable().optional()
});

export const AnchorCorrespondenceSchema = z.object({
  pointId: z.string().min(1),
  reference: PointSchema,
  current: PointSchema,
  confidence: z.number().min(0).max(1)
});

export const RecoveryEventSchema = z.object({
  id: z.string().min(1),
  frame: z.number().int().nonnegative(),
  kind: z.enum(["requested", "anchors-selected", "applied", "rolled-back", "rejected"]),
  anchorCount: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(1),
  inlierRatio: z.number().min(0).max(1),
  predictedMedianError: z.number().nonnegative(),
  reversible: z.boolean(),
  message: z.string().optional()
});

export const TrackingEventSchema = z.object({
  id: z.string().min(1),
  frame: z.number().int().nonnegative(),
  kind: z.enum([
    "initialized",
    "model-switched",
    "low-confidence",
    "lost",
    "reconnected",
    "reviewed",
    "export-failed"
  ]),
  message: z.string(),
  recoverable: z.boolean()
});

export const RiskNoticeSchema = z.object({
  id: z.string().min(1),
  code: z.enum([
    "secure-context.required",
    "browser.unsupported",
    "camera.unsupported",
    "camera.permission-denied",
    "camera.unavailable",
    "camera.no-device",
    "camera.orientation-changed",
    "opencv.load-failed",
    "opencv.feature-unavailable",
    "refinement.invalid-roi",
    "refinement.low-confidence",
    "refinement.gate-failed",
    "registration.rejected",
    "tracking.identity-gate-failed",
    "tracking.lost",
    "tracking.frame-budget",
    "device.low-battery",
    "device.overheat",
    "recording.unsupported",
    "video.decode-failed",
    "image.decode-failed",
    "storage.low",
    "export.failed"
  ]),
  severity: z.enum(["info", "warning", "error"]),
  frame: z.number().int().nonnegative(),
  pointId: z.string().min(1).optional(),
  message: z.string().min(1),
  action: z.enum([
    "none",
    "open-settings",
    "retry",
    "reselect-roi",
    "continue-local",
    "select-anchors",
    "pause",
    "resume",
    "select-file",
    "export-current"
  ]),
  recoverable: z.boolean(),
  createdAt: z.number().nonnegative().optional()
});

export const CameraSessionSchema = z.object({
  status: z.enum(["idle", "requesting", "ready", "denied", "unsupported", "stopped", "error"]),
  facingMode: z.enum(["environment", "user"]).nullable(),
  nativeWidth: z.number().int().positive().nullable(),
  nativeHeight: z.number().int().positive().nullable(),
  recording: z.boolean(),
  error: z.string().nullable()
});

export const ProcessingStatsSchema = z.object({
  processedFrames: z.number().int().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  fps: z.number().nonnegative(),
  p95LatencyMs: z.number().nonnegative(),
  engine: z.enum(["typescript", "opencv-js", "degraded"]),
  nativeWidth: z.number().int().positive().nullable(),
  nativeHeight: z.number().int().positive().nullable()
});

export const ReportManifestSchema = z.object({
  jobId: z.string().min(1),
  algorithmVersion: z.string().min(1),
  summary: z.record(z.number()),
  assets: z.array(
    z.object({
      kind: z.string().min(1),
      path: z.string().min(1)
    })
  ),
  parameters: z.record(z.unknown())
});

export type Roi = z.infer<typeof RoiSchema>;
export type ExtractionIntent = z.infer<typeof ExtractionIntentSchema>;
export type RefinementGeometry = z.infer<typeof RefinementGeometrySchema>;
export type FeatureRefinement = z.infer<typeof FeatureRefinementSchema>;
export type FeatureDraft = z.infer<typeof FeatureDraftSchema>;
export type TrackingJob = z.infer<typeof TrackingJobSchema>;
export type PointTrack = z.infer<typeof PointTrackSchema>;
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;
export type ReportManifest = z.infer<typeof ReportManifestSchema>;
export type FeatureModelType = z.infer<typeof FeatureModelTypeSchema>;
export type Point = z.infer<typeof PointSchema>;
export type PointSeed = z.infer<typeof PointSeedSchema>;
export type MultiPointJob = z.infer<typeof MultiPointJobSchema>;
export type MultiPointTrack = z.infer<typeof MultiPointTrackSchema>;
export type FrameRegistration = z.infer<typeof FrameRegistrationSchema>;
export type AnchorCorrespondence = z.infer<typeof AnchorCorrespondenceSchema>;
export type RecoveryEvent = z.infer<typeof RecoveryEventSchema>;
export type RiskNotice = z.infer<typeof RiskNoticeSchema>;
export type CameraSession = z.infer<typeof CameraSessionSchema>;
export type ProcessingStats = z.infer<typeof ProcessingStatsSchema>;

export type LocalFrame = {
  frame: number;
  timestampMs: number;
  width: number;
  height: number;
  source: "camera" | "image" | "video";
};

export type EngineStatus = {
  opencv: "ready" | "unavailable";
  version?: string;
  capabilities: { refinement: boolean; registration: boolean; descriptors: boolean };
};
