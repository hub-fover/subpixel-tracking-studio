import { z } from "zod";

const FeatureModelTypeSchema = z.enum([
  "circle",
  "blob",
  "crosshair",
  "diagonal",
  "speckle",
  "natural-keypoint"
]);

export const ExportFormatSchema = z.enum([
  "csv",
  "json",
  "xlsx",
  "pdf",
  "images",
  "video",
  "bundle"
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
  residualSemantics: z.enum([
    "geometric-fit-error-px",
    "line-intersection-fit-error-px",
    "blob-center-fit-error-px",
    "matching-error-model-specific"
  ]).optional(),
  loweRatio: z.number().min(0).max(1).nullable().optional(),
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

export const ReportMetadataSchema = z.object({
  reportNumber: z.string().min(1),
  reportId: z.string().min(1),
  projectName: z.string().default(""),
  testId: z.string().default(""),
  operator: z.string().default(""),
  notes: z.string().default(""),
  sourceFile: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
  buildCommit: z.string().min(1)
});

export const QualityThresholdsSchema = z.object({
  passValidRatio: z.number().min(0).max(1).default(.95),
  reviewValidRatio: z.number().min(0).max(1).default(.8),
  passConfidenceP50: z.number().min(0).max(1).default(.8),
  reviewConfidenceP50: z.number().min(0).max(1).default(.55),
  failLostRatio: z.number().min(0).max(1).default(.2),
  reviewDroppedFrameRatio: z.number().min(0).max(1).default(.1)
}).superRefine((value, context) => {
  if (value.reviewValidRatio > value.passValidRatio) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewValidRatio"], message: "reviewValidRatio must be <= passValidRatio" });
  if (value.reviewConfidenceP50 > value.passConfidenceP50) context.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewConfidenceP50"], message: "reviewConfidenceP50 must be <= passConfidenceP50" });
});

export const QualityGradeSchema = z.enum(["pass", "review", "fail", "not-evaluated"]);

export const ReportOptionsSchema = z.object({
  includedAssets: z.array(z.string().min(1)).default([]),
  keyFrameCount: z.number().int().min(0).max(20).default(20),
  imageQuality: z.enum(["full", "lightweight"]).default("full"),
  language: z.string().min(1).default("zh-CN")
});

const ReportAssetSchema = z.object({
  kind: z.string().min(1),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  status: z.enum(["generated", "failed", "skipped"]).optional(),
  failureReason: z.string().optional()
});

export const ReportManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  reportId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  algorithmVersion: z.string().min(1).optional(),
  source: z.object({ kind: z.enum(["image-sequence", "video", "camera"]), name: z.string().min(1) }).optional(),
  grade: QualityGradeSchema.optional(),
  thresholds: QualityThresholdsSchema.optional(),
  summary: z.record(z.number()).optional(),
  assets: z.array(ReportAssetSchema).optional(),
  parameters: z.record(z.unknown()).optional(),
  engine: z.enum(["typescript", "opencv-js", "degraded"]).optional(),
  originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  processingStats: ProcessingStatsSchema.optional(),
  buildCommit: z.string().min(1).optional()
}).superRefine((value, context) => {
  const requiredV2 = ["reportId", "jobId", "algorithmVersion", "source", "grade", "thresholds", "engine", "originalDimensions", "processingStats", "buildCommit", "assets", "parameters"] as const;
  if (value.schemaVersion !== 2) {
    for (const field of ["jobId", "algorithmVersion", "summary", "assets", "parameters"] as const) {
      if (value[field] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for legacy report manifests` });
    }
    return;
  }
  for (const field of requiredV2) {
    if (value[field] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for report manifest v2` });
  }
  value.assets.forEach((asset, index) => {
    if (!asset.status) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "status"], message: "status is required for report manifest v2 assets" });
    if (asset.status === "generated" && asset.bytes === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "bytes"], message: "bytes is required for generated assets" });
    if (asset.status === "generated" && asset.sha256 === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "sha256"], message: "sha256 is required for generated assets" });
    if (asset.status === "failed" && !asset.failureReason) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", index, "failureReason"], message: "failureReason is required for failed assets" });
  });
});

export const ReportResidualSemanticsSchema = z.enum([
  "geometric-fit-error-px",
  "line-intersection-fit-error-px",
  "blob-center-fit-error-px",
  "matching-error-model-specific"
]);

const ReportStateCountsSchema = z.object({
  valid: z.number().int().nonnegative(), suspect: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(), paused: z.number().int().nonnegative()
});
const ReportExecutionSchema = z.object({
  pointCount: z.number().int().nonnegative(), frameCount: z.number().int().nonnegative(), sampleCount: z.number().int().nonnegative(),
  stateCounts: ReportStateCountsSchema, validRatio: z.number().min(0).max(1), lostRatio: z.number().min(0).max(1),
  droppedFrameRatio: z.number().min(0).max(1), processingStats: ProcessingStatsSchema
});
const ReportCoordinateSchema = PointSchema.nullable();
const ReportRangeSchema = z.object({ min: z.number().finite(), max: z.number().finite() }).nullable();
const ReportPointSchema = z.object({
  pointId: z.string().min(1), model: FeatureModelTypeSchema.nullable(), grade: QualityGradeSchema,
  finalState: z.enum(["valid", "suspect", "lost", "reviewed", "paused"]).nullable(), sampleCount: z.number().int().nonnegative(),
  stateCounts: ReportStateCountsSchema, validRatio: z.number().min(0).max(1), lostRatio: z.number().min(0).max(1),
  start: ReportCoordinateSchema, end: ReportCoordinateSchema, dx: z.number().finite().nullable(), dy: z.number().finite().nullable(),
  xRange: ReportRangeSchema, yRange: ReportRangeSchema,
  confidence: z.object({ p50: z.number().min(0).max(1).nullable(), p95: z.number().min(0).max(1).nullable() }),
  gatingFailures: z.record(z.number().int().nonnegative()), relocationMethods: z.record(z.number().int().nonnegative())
});
const ReportTrackSchema = MultiPointTrackSchema.extend({ residualSemantics: ReportResidualSemanticsSchema });
const ReportChartSampleSchema = z.object({ pointId: z.string().min(1), frame: z.number().int().nonnegative(), x: z.number().finite(), y: z.number().finite(), dx: z.number().finite().nullable(), dy: z.number().finite().nullable(), confidence: z.number().min(0).max(1), residual: z.number().nonnegative() });
const ReportRegistrationSchema = z.object({
  count: z.number().int().nonnegative(), acceptedCount: z.number().int().nonnegative(), rejectedCount: z.number().int().nonnegative(), successRate: z.number().min(0).max(1),
  meanInlierRatio: z.number().min(0).max(1).nullable(), medianInlierRatio: z.number().min(0).max(1).nullable(), meanReprojectionError: z.number().nonnegative().nullable(), p95ReprojectionError: z.number().nonnegative().nullable(), methodDistribution: z.record(z.number().int().nonnegative())
});
const ReportAnomalyIntervalSchema = z.object({ pointId: z.string().min(1), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative(), frameCount: z.number().int().positive(), worstState: z.enum(["valid", "suspect", "lost", "reviewed", "paused"]), minimumConfidence: z.number().min(0).max(1), maximumResidual: z.number().nonnegative() });
const ReportKeyFrameSchema = z.object({ pointId: z.string().min(1), frame: z.number().int().nonnegative(), reason: z.enum(["regular", "abnormal-boundary"]), track: ReportTrackSchema });

export const ReportModelSchema = z.object({
  metadata: ReportMetadataSchema,
  thresholds: QualityThresholdsSchema,
  options: ReportOptionsSchema,
  grade: QualityGradeSchema,
  execution: ReportExecutionSchema,
  points: z.array(ReportPointSchema),
  tracks: z.array(ReportTrackSchema),
  chartSeries: z.array(z.object({ pointId: z.string().min(1), samples: z.array(ReportChartSampleSchema).max(1000) })),
  registration: ReportRegistrationSchema,
  anomalyIntervals: z.array(ReportAnomalyIntervalSchema),
  risks: z.array(RiskNoticeSchema),
  humanInterventions: z.array(z.record(z.unknown())),
  keyFrames: z.array(ReportKeyFrameSchema)
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
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export type ReportMetadata = z.infer<typeof ReportMetadataSchema>;
export type QualityThresholds = z.infer<typeof QualityThresholdsSchema>;
export type QualityGrade = z.infer<typeof QualityGradeSchema>;
export type ReportOptions = z.infer<typeof ReportOptionsSchema>;
export type ReportResidualSemantics = z.infer<typeof ReportResidualSemanticsSchema>;
export type ReportModel = z.infer<typeof ReportModelSchema>;
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
