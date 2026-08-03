import type { ReportManifest, ReportModel } from "@subpixel/contracts";
import { fontBytesToBase64, loadReportPdfFont, validateTrueTypeFont, validateUnicodePdf } from "./reportPdfFont";
import { renderEngineeringReportPdf, type EngineeringReportImages } from "./engineeringReportPdf";

export { validateTrueTypeFont } from "./reportPdfFont";

export type ReportExportProgress = {
  phase: "preflight" | "data" | "pdf" | "xlsx" | "manifest" | "zip" | "complete";
  completed: number;
  total: number;
  message: string;
};

export type ReportBuildOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: ReportExportProgress) => void;
};

export type ReportAssetResult = {
  kind: string;
  path: string;
  data?: Uint8Array | Blob | string;
  error?: string;
  skipped?: boolean;
};

export function sanitizeReportFileName(value: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ");
  return normalized || "subpixel-report";
}

export function reportFileStem(report: ReportModel): string {
  const source = report.metadata.projectName || report.metadata.sourceFile.replace(/\.[^.]+$/, "") || "subpixel";
  const timestamp = report.metadata.generatedAt.replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${sanitizeReportFileName(source)}_${timestamp}_subpixel-report`;
}

function scalar(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function csvCell(value: unknown): string {
  const text = String(scalar(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvWithBom(rows: unknown[][]): string {
  return `\ufeff${rows.map(row => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  return csvWithBom([columns, ...rows.map(row => columns.map(column => row[column]))]);
}

function pointRows(report: ReportModel) {
  return report.points.map(point => ({
    point_id: point.pointId,
    group_id: point.groupId ?? "",
    model: point.model ?? "",
    grade: point.grade,
    final_state: point.finalState ?? "",
    sample_count: point.sampleCount,
    valid_ratio: point.validRatio,
    lost_ratio: point.lostRatio,
    start_x_px: point.start?.x ?? "",
    start_y_px: point.start?.y ?? "",
    end_x_px: point.end?.x ?? "",
    end_y_px: point.end?.y ?? "",
    delta_x_px: point.dx ?? "",
    delta_y_px: point.dy ?? "",
    confidence_p50: point.confidence.p50 ?? "",
    confidence_p95: point.confidence.p95 ?? "",
    gating_failures: JSON.stringify(point.gatingFailures),
    relocation_methods: JSON.stringify(point.relocationMethods)
  }));
}

function trackRows(report: ReportModel) {
  return report.tracks.map(track => ({
    point_id: track.pointId,
    frame: track.frame,
    timestamp_ms: track.timestampMs,
    predicted_x_px: track.predicted.x,
    predicted_y_px: track.predicted.y,
    x_px: track.refined.x,
    y_px: track.refined.y,
    model: track.model,
    residual: track.residual,
    residual_semantics: track.residualSemantics,
    confidence: track.confidence,
    lowe_ratio: track.loweRatio ?? "",
    flow_fb_error: track.flowErrorForwardBackward ?? "",
    ncc: track.ncc ?? "",
    descriptor_distance: track.descriptorDistance ?? "",
    epipolar_error: track.epipolarError ?? "",
    prediction_source: track.predictionSource,
    innovation_px: track.innovationPx,
    local_affine_residual_px: track.localAffineResidualPx ?? "",
    gate_failures: JSON.stringify(track.gateFailures),
    candidate_uniqueness: track.candidateUniqueness ?? "",
    registration_decision: track.registrationDecision ?? "",
    point_gate_passed: track.pointGatePassed ?? "",
    topology_error_px: track.topologyErrorPx ?? "",
    missing_reason: track.missingReason ?? "",
    state: track.state,
    relocation_method: track.relocationMethod
  }));
}

function registrationRows(report: ReportModel) {
  return report.registrations.map(registration => ({
    frame: registration.frame,
    method: registration.method,
    accepted: registration.accepted ?? "",
    decision: registration.decision ?? (registration.accepted === true ? "accepted" : registration.accepted === false ? "rejected" : ""),
    usable_for_prediction: registration.usableForPrediction ?? "",
    failure_class: registration.failureClass ?? "",
    guidance_source: registration.guidanceSource ?? "",
    match_count: registration.matchCount,
    inlier_count: registration.inlierCount,
    inlier_ratio: registration.inlierRatio,
    median_reprojection_error_px: registration.reprojectionErrorSemantics !== "not-available" && Number.isFinite(registration.medianReprojectionError) ? registration.medianReprojectionError : "",
    reprojection_error_semantics: registration.reprojectionErrorSemantics ?? "pixel-reprojection",
    p95_latency_ms: registration.p95LatencyMs ?? "",
    source_frame: registration.sourceFrame ?? "",
    target_frame: registration.targetFrame ?? registration.frame,
    inlier_coverage: registration.inlierCoverage ?? "",
    median_symmetric_transfer_error_px: registration.medianSymmetricTransferError ?? "",
    transform_consistency_error_px: registration.transformConsistencyError ?? "",
    transform_kind: registration.transform?.kind ?? "",
    transform_matrix: registration.transform ? JSON.stringify(registration.transform.matrix) : "",
    inverse_transform_matrix: registration.inverseTransform ? JSON.stringify(registration.inverseTransform.matrix) : "",
    reason: registration.reason ?? ""
  }));
}

const POINT_COLUMNS = ["point_id", "group_id", "model", "grade", "final_state", "sample_count", "valid_ratio", "lost_ratio", "start_x_px", "start_y_px", "end_x_px", "end_y_px", "delta_x_px", "delta_y_px", "confidence_p50", "confidence_p95", "gating_failures", "relocation_methods"];
const TRACK_COLUMNS = ["point_id", "frame", "timestamp_ms", "predicted_x_px", "predicted_y_px", "x_px", "y_px", "model", "residual", "residual_semantics", "confidence", "lowe_ratio", "flow_fb_error", "ncc", "descriptor_distance", "epipolar_error", "state", "relocation_method", "prediction_source", "innovation_px", "local_affine_residual_px", "gate_failures", "candidate_uniqueness", "registration_decision", "point_gate_passed", "topology_error_px", "missing_reason"];

export function buildReportCsvFiles(report: ReportModel): Record<string, string> {
  const points = pointRows(report);
  const tracks = trackRows(report);
  return {
    "points.csv": table(points, POINT_COLUMNS),
    "tracks.csv": table(tracks, TRACK_COLUMNS),
    "frame-ledger.csv": table(report.frameLedger.map(entry => ({ ...entry })), ["inputIndex", "frame", "sourceName", "timestampMs", "decodeStatus", "processingStatus", "validCount", "provisionalCount", "suspectCount", "missingCount", "keyframe", "registrationDecision", "failureReason"]),
    "topology.csv": table(report.topology.map(edge => ({ ...edge })), ["edgeId", "groupId", "sourcePointId", "targetPointId", "referenceLengthPx", "enabled"]),
    "registrations.csv": table(registrationRows(report), ["frame", "method", "accepted", "decision", "usable_for_prediction", "failure_class", "guidance_source", "match_count", "inlier_count", "inlier_ratio", "median_reprojection_error_px", "reprojection_error_semantics", "p95_latency_ms", "source_frame", "target_frame", "inlier_coverage", "median_symmetric_transfer_error_px", "transform_consistency_error_px", "transform_kind", "transform_matrix", "inverse_transform_matrix", "reason"]),
    "internal-errors.csv": table(Object.entries(report.internalQuality).map(([metric, summary]) => ({ metric, ...summary })), ["metric", "count", "p50", "p95", "max"]),
    "ground-truth-errors.csv": table(report.groundTruthErrors.map(error => ({ ...error })), ["pointId", "unit", "count", "biasX", "biasY", "maeX", "maeY", "rmseX", "rmseY", "radialP95", "radialMax"]),
    "events.csv": table([...report.events.map(event => ({ ...event })), ...report.humanInterventions], ["kind", "frame", "pointId", "message", "anchorCount", "coverage", "inlierRatio"]),
    "risks.csv": table(report.risks.map(risk => ({ ...risk })), ["id", "code", "severity", "frame", "pointId", "message", "action", "recoverable"])
  };
}

async function bytes(data: ReportAssetResult["data"]): Promise<Uint8Array> {
  if (!data) return new Uint8Array();
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array(await data.arrayBuffer());
}

async function sha256(data: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  }
  return "";
}

function reportSourceKind(sourceFile: string): "image-sequence" | "video" | "camera" {
  if (sourceFile === "camera") return "camera";
  return /\.(mp4|mov|webm|avi|mkv)$/i.test(sourceFile) ? "video" : "image-sequence";
}

function cancelledError(): Error & { code: string; recoverable: boolean } {
  return Object.assign(new Error("报告生成已取消"), { code: "export.cancelled", recoverable: true });
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelledError();
}

function reportProgress(options: ReportBuildOptions | undefined, progress: ReportExportProgress) {
  options?.onProgress?.(progress);
  checkCancelled(options?.signal);
}

export async function buildReportManifest(report: ReportModel, assets: ReportAssetResult[]): Promise<ReportManifest> {
  const manifestAssets = await Promise.all(assets.map(async asset => {
    if (asset.error) return { kind: asset.kind, path: asset.path, status: "failed" as const, failureReason: asset.error };
    if (asset.skipped) return { kind: asset.kind, path: asset.path, status: "skipped" as const };
    const data = await bytes(asset.data);
    return { kind: asset.kind, path: asset.path, status: "generated" as const, bytes: data.byteLength, sha256: await sha256(data) };
  }));
  return {
    schemaVersion: 3,
    reportId: report.metadata.reportId,
    jobId: report.metadata.reportId,
    algorithmVersion: "report-model-v3",
    source: { kind: reportSourceKind(report.metadata.sourceFile), name: report.metadata.sourceFile },
    grade: report.grade,
    thresholds: report.thresholds,
    summary: { points: report.execution.pointCount, frames: report.execution.frameCount, inputFrames: report.execution.inputFrameCount, processedFrames: report.execution.processedFrameCount, provisionalSamples: report.execution.stateCounts.provisional, missingFrames: report.execution.missingFrameCount, tracks: report.execution.sampleCount, validRatio: report.execution.validRatio, lostRatio: report.execution.lostRatio },
    assets: manifestAssets,
    parameters: { options: report.options, calibration: report.calibration, topologyEdges: report.topology.length },
    engine: report.execution.processingStats.engine,
    ...(report.execution.processingStats.nativeWidth && report.execution.processingStats.nativeHeight ? { originalDimensions: { width: report.execution.processingStats.nativeWidth, height: report.execution.processingStats.nativeHeight } } : { originalDimensions: { width: 1, height: 1 } }),
    processingStats: report.execution.processingStats,
    buildCommit: report.metadata.buildCommit
  };
}

export function reportJson(report: ReportModel): string {
  return JSON.stringify(report, null, 2);
}

export async function buildReportXlsx(report: ReportModel, options?: ReportBuildOptions): Promise<Blob> {
  checkCancelled(options?.signal);
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const add = (name: string, rows: Array<Record<string, unknown>>) => {
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: "无数据" }]);
    sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, range.e.r), c: range.e.c } }) };
    sheet["!cols"] = Array.from({ length: range.e.c + 1 }, (_, column) => ({ wch: Math.min(42, Math.max(11, ...Object.keys(rows[0] ?? { note: "" }).map((_, index) => index === column ? 16 : 0))) }));
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  add("文控", [{ report_number: report.metadata.reportNumber, report_id: report.metadata.reportId, version: "V1.0", project: report.metadata.projectName, test_id: report.metadata.testId, prepared_by: report.metadata.operator, reviewed_by: "", approved_by: "", generated_at: report.metadata.generatedAt, build_commit: report.metadata.buildCommit, note: "质量等级仅代表算法门控结果，不构成计量检定结论。" }]);
  add("帧台账", report.frameLedger.map(entry => ({ ...entry })));
  add("点", pointRows(report));
  add("轨迹", trackRows(report));
  add("拓扑", report.topology.map(edge => ({ ...edge })));
  add("配准", registrationRows(report));
  add("内部误差", Object.entries(report.internalQuality).map(([metric, summary]) => ({ metric, ...summary })));
  add("真值误差", report.groundTruthErrors.map(error => ({ ...error })));
  add("事件", [...report.events.map(event => ({ ...event })), ...report.humanInterventions]);
  add("风险", report.risks.map(risk => ({ ...risk })));
  add("参数", [{ ...report.thresholds, ...report.options, calibration: report.calibration ? JSON.stringify(report.calibration) : "未标定", schema_version: report.schemaVersion, grade: report.grade, ...report.execution }]);
  checkCancelled(options?.signal);
  const data = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function buildReportPdf(report: ReportModel, annotatedImage?: string | EngineeringReportImages, options?: ReportBuildOptions): Promise<Blob> {
  checkCancelled(options?.signal);
  const font = await loadReportPdfFont(options?.signal);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "pt" });
  doc.addFileToVFS("NotoSansSC-Variable.ttf", fontBytesToBase64(font));
  doc.addFont("NotoSansSC-Variable.ttf", "NotoSansSC", "normal");
  doc.setFont("NotoSansSC");
  const images = typeof annotatedImage === "string"
    ? { reference: annotatedImage, current: annotatedImage }
    : annotatedImage ?? {};
  renderEngineeringReportPdf(doc, report, images, (index, total) => {
    checkCancelled(options?.signal);
    options?.onProgress?.({ phase: "pdf", completed: index + 1, total: Math.max(1, total), message: `生成逐点页面 ${index + 1}/${total}` });
  });
  const output = new Uint8Array(doc.output("arraybuffer"));
  validateUnicodePdf(output);
  return new Blob([output], { type: "application/pdf" });
}

export async function buildReportBundle(report: ReportModel, assets: ReportAssetResult[] = [], annotatedImage?: string | EngineeringReportImages, options?: ReportBuildOptions): Promise<{ blob: Blob; manifest: ReportManifest }> {
  reportProgress(options, { phase: "preflight", completed: 0, total: 6, message: "检查报告资产" });
  const csvFiles = buildReportCsvFiles(report);
  checkCancelled(options?.signal);
  const generated: ReportAssetResult[] = [
    { kind: "json", path: "data/report.json", data: reportJson(report) },
    ...Object.entries(csvFiles).map(([name, data]) => ({ kind: "csv", path: `data/${name}`, data })),
    ...assets
  ];
  reportProgress(options, { phase: "data", completed: 1, total: 6, message: "整理 JSON 与 CSV" });
  try { generated.push({ kind: "pdf", path: "report.pdf", data: await buildReportPdf(report, annotatedImage, options) }); } catch (error) { if ((error as { code?: string }).code === "export.cancelled") throw error; generated.push({ kind: "pdf", path: "report.pdf", error: error instanceof Error ? error.message : "PDF 生成失败" }); }
  reportProgress(options, { phase: "pdf", completed: 2, total: 6, message: "生成中文 PDF" });
  checkCancelled(options?.signal);
  try { generated.push({ kind: "xlsx", path: "report.xlsx", data: await buildReportXlsx(report, options) }); } catch (error) { if ((error as { code?: string }).code === "export.cancelled") throw error; generated.push({ kind: "xlsx", path: "report.xlsx", error: error instanceof Error ? error.message : "XLSX 生成失败" }); }
  reportProgress(options, { phase: "xlsx", completed: 3, total: 6, message: "生成 XLSX 数据表" });
  checkCancelled(options?.signal);
  const selectedAssets = new Set(report.options.includedAssets);
  const allAssets = selectedAssets.size
    ? generated.map(asset => selectedAssets.has(asset.path) ? asset : { ...asset, data: undefined, skipped: true })
    : generated;
  const manifest = await buildReportManifest(report, allAssets);
  reportProgress(options, { phase: "manifest", completed: 4, total: 6, message: "计算资产哈希" });
  const { zipSync } = await import("fflate");
  checkCancelled(options?.signal);
  const entries: Record<string, Uint8Array> = { "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)) };
  for (const asset of allAssets) if (!asset.error && !asset.skipped) entries[asset.path] = await bytes(asset.data);
  reportProgress(options, { phase: "zip", completed: 5, total: 6, message: "打包 ZIP" });
  const blob = new Blob([zipSync(entries, { level: 6 })], { type: "application/zip" });
  reportProgress(options, { phase: "complete", completed: 6, total: 6, message: "报告包生成完成" });
  return { blob, manifest };
}
