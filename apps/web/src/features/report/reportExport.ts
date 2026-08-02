import type { ReportManifest, ReportModel } from "@subpixel/contracts";

export type ReportAssetResult = {
  kind: string;
  path: string;
  data?: Uint8Array | Blob | string;
  error?: string;
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
    state: track.state,
    relocation_method: track.relocationMethod
  }));
}

const POINT_COLUMNS = ["point_id", "model", "grade", "final_state", "sample_count", "valid_ratio", "lost_ratio", "start_x_px", "start_y_px", "end_x_px", "end_y_px", "delta_x_px", "delta_y_px", "confidence_p50", "confidence_p95", "gating_failures", "relocation_methods"];
const TRACK_COLUMNS = ["point_id", "frame", "timestamp_ms", "predicted_x_px", "predicted_y_px", "x_px", "y_px", "model", "residual", "residual_semantics", "confidence", "lowe_ratio", "flow_fb_error", "ncc", "descriptor_distance", "epipolar_error", "state", "relocation_method"];

export function buildReportCsvFiles(report: ReportModel): Record<string, string> {
  const points = pointRows(report);
  const tracks = trackRows(report);
  return {
    "points.csv": table(points, POINT_COLUMNS),
    "tracks.csv": table(tracks, TRACK_COLUMNS),
    "registrations.csv": table(report.registrations.map(registration => ({
      frame: registration.frame,
      method: registration.method,
      accepted: registration.accepted ?? "",
      match_count: registration.matchCount,
      inlier_count: registration.inlierCount,
      inlier_ratio: registration.inlierRatio,
      median_reprojection_error_px: Number.isFinite(registration.medianReprojectionError) ? registration.medianReprojectionError : "",
      p95_latency_ms: registration.p95LatencyMs ?? "",
      reason: registration.reason ?? ""
    })), ["frame", "method", "accepted", "match_count", "inlier_count", "inlier_ratio", "median_reprojection_error_px", "p95_latency_ms", "reason"]),
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

export async function buildReportManifest(report: ReportModel, assets: ReportAssetResult[]): Promise<ReportManifest> {
  const manifestAssets = await Promise.all(assets.map(async asset => {
    if (asset.error) return { kind: asset.kind, path: asset.path, status: "failed" as const, failureReason: asset.error };
    const data = await bytes(asset.data);
    return { kind: asset.kind, path: asset.path, status: "generated" as const, bytes: data.byteLength, sha256: await sha256(data) };
  }));
  return {
    schemaVersion: 2,
    reportId: report.metadata.reportId,
    jobId: report.metadata.reportId,
    algorithmVersion: "report-model-v2",
    source: { kind: "video", name: report.metadata.sourceFile },
    grade: report.grade,
    thresholds: report.thresholds,
    summary: { points: report.execution.pointCount, frames: report.execution.frameCount, tracks: report.execution.sampleCount, validRatio: report.execution.validRatio, lostRatio: report.execution.lostRatio },
    assets: manifestAssets,
    parameters: { options: report.options },
    engine: report.execution.processingStats.engine,
    ...(report.execution.processingStats.nativeWidth && report.execution.processingStats.nativeHeight ? { originalDimensions: { width: report.execution.processingStats.nativeWidth, height: report.execution.processingStats.nativeHeight } } : { originalDimensions: { width: 1, height: 1 } }),
    processingStats: report.execution.processingStats,
    buildCommit: report.metadata.buildCommit
  };
}

export function reportJson(report: ReportModel): string {
  return JSON.stringify(report, null, 2);
}

export async function buildReportXlsx(report: ReportModel): Promise<Blob> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const add = (name: string, rows: Array<Record<string, unknown>>) => {
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: "无数据" }]);
    sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  };
  add("说明", [{ report_id: report.metadata.reportId, grade: report.grade, note: "质量等级仅代表算法门控结果，不构成计量检定结论。" }]);
  add("摘要", [{ ...report.execution, grade: report.grade }]);
  add("点", pointRows(report));
  add("轨迹", trackRows(report));
  add("配准", report.registrations.map(registration => ({ ...registration })));
  add("事件", [...report.events.map(event => ({ ...event })), ...report.humanInterventions]);
  add("风险", report.risks.map(risk => ({ ...risk })));
  add("参数", [{ ...report.thresholds, ...report.options }]);
  const data = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export async function buildReportPdf(report: ReportModel, annotatedImage?: string): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "pt" });
  try {
    const response = await fetch(`${import.meta.env.BASE_URL ?? "/"}fonts/NotoSansSC-Regular.otf`);
    if (!response.ok) throw new Error(`font request failed: ${response.status}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, Math.min(index + 0x8000, buffer.length)));
    const base64 = btoa(binary);
    doc.addFileToVFS("NotoSansSC-Regular.otf", base64);
    doc.addFont("NotoSansSC-Regular.otf", "NotoSansSC", "normal");
    doc.setFont("NotoSansSC");
  } catch {
    doc.setFont("helvetica");
  }
  const title = "亚像素特征提取与跟踪报告";
  const write = (value: string, x: number, y: number, size = 10) => { doc.setFontSize(size); doc.text(value, x, y); };
  write(title, 42, 52, 18);
  write(`报告编号: ${report.metadata.reportNumber}`, 42, 74);
  write(`项目: ${report.metadata.projectName || "未填写"}    试验: ${report.metadata.testId || "未填写"}`, 42, 92);
  write(`质量结论: ${report.grade}    点数: ${report.execution.pointCount}    帧数: ${report.execution.frameCount}`, 42, 110);
  write("说明：质量等级仅代表算法门控结果；无标定和计量溯源时不构成计量检定结论。", 42, 130, 9);
  if (annotatedImage) doc.addImage(annotatedImage, "PNG", 42, 148, 510, 300);
  let y = annotatedImage ? 478 : 160;
  write("执行摘要", 42, y, 14); y += 22;
  write(`有效率 ${(report.execution.validRatio * 100).toFixed(2)}%    失锁率 ${(report.execution.lostRatio * 100).toFixed(2)}%    P95 延迟 ${report.execution.processingStats.p95LatencyMs.toFixed(2)} ms`, 42, y); y += 30;
  write("逐点质量", 42, y, 14); y += 18;
  for (const point of report.points.slice(0, 28)) {
    write(`${point.pointId}  ${point.model ?? "-"}  ${point.grade}  样本 ${point.sampleCount}  置信度P50 ${point.confidence.p50?.toFixed(3) ?? "-"}`, 48, y, 9); y += 14;
    if (y > 760) { doc.addPage(); y = 52; }
  }
  doc.addPage(); y = 52; write("配准、风险与人工干预", 42, y, 14); y += 22;
  write(`配准次数 ${report.registration.count}    成功率 ${(report.registration.successRate * 100).toFixed(2)}%    中位内点率 ${report.registration.medianInlierRatio?.toFixed(3) ?? "-"}`, 42, y, 10); y += 22;
  for (const risk of report.risks.slice(0, 35)) { write(`风险 frame ${risk.frame}: ${risk.message}（动作：${risk.action}）`, 48, y, 9); y += 14; if (y > 760) { doc.addPage(); y = 52; } }
  if (y > 700) { doc.addPage(); y = 52; }
  write("方法、阈值与限制", 42, y + 20, 14);
  write(`阈值：有效率 ${report.thresholds.passValidRatio}/${report.thresholds.reviewValidRatio}，置信度P50 ${report.thresholds.passConfidenceP50}/${report.thresholds.reviewConfidenceP50}，失锁率 ${report.thresholds.failLostRatio}。`, 42, y + 42, 9);
  write("原始逐帧数据保存在 JSON/XLSX/CSV；图表仅做 min/max 保真采样。", 42, y + 58, 9);
  return doc.output("blob");
}

export async function buildReportBundle(report: ReportModel, assets: ReportAssetResult[] = [], annotatedImage?: string): Promise<{ blob: Blob; manifest: ReportManifest }> {
  const csvFiles = buildReportCsvFiles(report);
  const generated: ReportAssetResult[] = [
    { kind: "json", path: "data/report.json", data: reportJson(report) },
    ...Object.entries(csvFiles).map(([name, data]) => ({ kind: "csv", path: `data/${name}`, data })),
    ...assets
  ];
  try { generated.push({ kind: "pdf", path: "report.pdf", data: await buildReportPdf(report, annotatedImage) }); } catch (error) { generated.push({ kind: "pdf", path: "report.pdf", error: error instanceof Error ? error.message : "PDF 生成失败" }); }
  try { generated.push({ kind: "xlsx", path: "report.xlsx", data: await buildReportXlsx(report) }); } catch (error) { generated.push({ kind: "xlsx", path: "report.xlsx", error: error instanceof Error ? error.message : "XLSX 生成失败" }); }
  const allAssets = generated;
  const manifest = await buildReportManifest(report, allAssets);
  const { zipSync } = await import("fflate");
  const entries: Record<string, Uint8Array> = { "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)) };
  for (const asset of allAssets) if (!asset.error) entries[asset.path] = await bytes(asset.data);
  return { blob: new Blob([zipSync(entries, { level: 6 })], { type: "application/zip" }), manifest };
}
