import type { FrameRegistration, MultiPointTrack, PointSeed, PointTrack, ProcessingStats, RecoveryEvent, RiskNotice, Roi, TrackingEvent } from "@subpixel/contracts";
import { reportResidualSemantics } from "./reportModel";

export type ExportFormat = "json" | "csv" | "xlsx" | "pdf" | "images" | "video";
export type ExportPayload = {
  tracks: PointTrack[];
  multiTracks?: MultiPointTrack[];
  seeds?: PointSeed[];
  points?: PointSeed[];
  registrations?: FrameRegistration[];
  recoveryEvents?: RecoveryEvent[];
  riskNotices?: RiskNotice[];
  processingStats?: ProcessingStats;
  events: TrackingEvent[];
  roi: Roi;
  model: string;
  image?: CanvasImageSource;
};

export type ExportDocument = {
  points: Array<Record<string, unknown>>;
  tracks: Array<Record<string, unknown>>;
  registrations: Array<Record<string, unknown>>;
  recoveryEvents: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  riskNotices: Array<Record<string, unknown>>;
  processingStats?: Record<string, unknown>;
};

export function overlayCanvasSize(source: { width?: number; height?: number; videoWidth?: number; videoHeight?: number }) {
  return { width: source.width ?? source.videoWidth ?? 1, height: source.height ?? source.videoHeight ?? 1 };
}

export function buildExportRows(payload: ExportPayload) {
  if (payload.multiTracks?.length) return [...payload.multiTracks]
    .sort((a, b) => a.frame - b.frame || a.pointId.localeCompare(b.pointId))
    .map(track => ({ point_id: track.pointId, frame: track.frame, timestamp_ms: track.timestampMs, predicted_x_px: track.predicted.x, predicted_y_px: track.predicted.y, x_px: track.refined.x, y_px: track.refined.y, model: track.model, residual: track.residual, residual_semantics: reportResidualSemantics(track.model), confidence: track.confidence, flow_fb_error: track.flowErrorForwardBackward, ncc: track.ncc, descriptor_distance: track.descriptorDistance, lowe_ratio: track.loweRatio ?? null, epipolar_error: track.epipolarError, state: track.state, relocation_method: track.relocationMethod }));
  return [...payload.tracks].sort((a, b) => a.frame - b.frame).map(track => ({ point_id: "p-001", frame: track.frame, timestamp_ms: track.timestampMs, x_px: track.x, y_px: track.y, model: track.model, residual: track.residual, confidence: track.confidence, state: track.state, duration_ms: track.durationMs }));
}

export function buildExportDocument(payload: Pick<ExportPayload, "points" | "seeds" | "tracks" | "multiTracks" | "registrations" | "recoveryEvents" | "events" | "riskNotices" | "processingStats">): ExportDocument {
  const points = (payload.points ?? payload.seeds ?? []).slice().sort((a, b) => a.pointId.localeCompare(b.pointId)).map(seed => ({
    point_id: seed.pointId, model: seed.model, intent: seed.intent ?? null, group_id: seed.groupId, selection_method: seed.selectionMethod ?? null,
    click_x_px: seed.click.x, click_y_px: seed.click.y, x_px: seed.snapped.x, y_px: seed.snapped.y,
    roi_x_px: seed.roi.x, roi_y_px: seed.roi.y, roi_width_px: seed.roi.width, roi_height_px: seed.roi.height,
    confidence: seed.quality?.confidence ?? seed.candidateScore, residual_px: seed.quality?.residualPx ?? null,
  }));
  const rows = buildExportRows({ tracks: payload.tracks, multiTracks: payload.multiTracks, events: [] as TrackingEvent[], roi: { x: 0, y: 0, width: 1, height: 1 }, model: "mixed" });
  return {
    points,
    tracks: rows.map(row => ({ record_type: "track", ...row })),
    registrations: (payload.registrations ?? []).map(row => ({ record_type: "registration", ...row })),
    recoveryEvents: (payload.recoveryEvents ?? []).map(row => ({ record_type: "recovery", ...row })),
    events: (payload.events ?? []).map(row => ({ record_type: "event", ...row })),
    riskNotices: (payload.riskNotices ?? []).map(row => ({ record_type: "risk", ...row })),
    processingStats: payload.processingStats ? { record_type: "processing", ...payload.processingStats } : undefined
  };
}

function download(blob: Blob, name: string) { const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(anchor.href), 1000); }

function markedCanvas(payload: ExportPayload) {
  const source = payload.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
  const size = overlayCanvasSize(source ?? {}); const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#111820"; ctx.fillRect(0, 0, size.width, size.height); if (payload.image) ctx.drawImage(payload.image, 0, 0, size.width, size.height);
  ctx.strokeStyle = "#f5b700"; ctx.lineWidth = Math.max(1, size.width / 3000); ctx.strokeRect(payload.roi.x, payload.roi.y, payload.roi.width, payload.roi.height);
  ctx.strokeStyle = "#00d4bd"; for (const track of payload.multiTracks ?? []) { ctx.beginPath(); ctx.arc(track.refined.x, track.refined.y, Math.max(2, size.width / 1200), 0, Math.PI * 2); ctx.stroke(); }
  for (const track of payload.tracks) { ctx.beginPath(); ctx.arc(track.x, track.y, Math.max(2, size.width / 1200), 0, Math.PI * 2); ctx.stroke(); }
  for (const seed of payload.points ?? payload.seeds ?? []) { ctx.beginPath(); ctx.arc(seed.snapped.x, seed.snapped.y, Math.max(2, size.width / 1200), 0, Math.PI * 2); ctx.stroke(); }
  return canvas;
}

export async function exportTracking(format: ExportFormat, payload: ExportPayload) {
  const points = payload.points ?? payload.seeds ?? [];
  if (!points.length && !payload.tracks.length && !payload.multiTracks?.length) throw Object.assign(new Error("娌℃湁鍙鍑虹殑鎻愮偣缁撴灉"), { code: "export.empty", recoverable: true });
  const document = buildExportDocument(payload); const data = buildExportRows(payload);
  if (format === "json") return download(new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), ...document }, null, 2)], { type: "application/json" }), "subpixel-results.json");
  if (format === "csv") {
    const records = [...document.points.map(row => ({ record_type: "point", ...row })), ...document.tracks, ...document.registrations, ...document.recoveryEvents, ...document.events, ...document.riskNotices, ...(document.processingStats ? [document.processingStats] : [])];
    const columns = [...new Set(records.flatMap(row => Object.keys(row)))]; const csv = [columns.join(","), ...records.map(row => { const record = row as Record<string, unknown>; return columns.map(column => JSON.stringify(record[column] ?? "")).join(","); })].join("\n");
    return download(new Blob([csv], { type: "text/csv;charset=utf-8" }), "subpixel-results.csv");
  }
  if (format === "xlsx") { const XLSX = await import("xlsx"); const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.points), "points"); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.tracks), "tracks"); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(document.registrations), "registrations"); XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([...document.recoveryEvents, ...document.events, ...document.riskNotices, ...(document.processingStats ? [document.processingStats] : [])]), "events"); XLSX.writeFile(workbook, "subpixel-results.xlsx"); return; }
  if (format === "pdf") { const { jsPDF } = await import("jspdf"); const doc = new jsPDF({ orientation: "landscape" }); doc.setFontSize(18); doc.text("Subpixel Multi-point Tracking Report", 14, 16); doc.setFontSize(10); doc.text(`Points: ${document.points.length}  Samples: ${data.length}`, 14, 25); doc.addImage(markedCanvas(payload).toDataURL("image/jpeg", .85), "JPEG", 14, 32, 170, 106); doc.save("subpixel-report.pdf"); return; }
  const canvas = markedCanvas(payload); if (format === "images") return canvas.toBlob(blob => blob && download(blob, "subpixel-overlay.png"), "image/png");
  const stream = canvas.captureStream(10); const recorder = new MediaRecorder(stream, { mimeType: "video/webm" }); const chunks: Blob[] = []; recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = () => download(new Blob(chunks, { type: "video/webm" }), "subpixel-overlay.webm"); recorder.start(); await new Promise(resolve => setTimeout(resolve, 600)); recorder.stop();
}
