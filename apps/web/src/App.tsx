import { useEffect, useRef, useState } from "react";
import { createMultiPointTracker, evaluateRecoveryAnchors, matchTemplateNcc, type GrayPatch, type MultiPointObservation } from "@subpixel/algorithms";
import type { AnchorCorrespondence, ExtractionIntent, FeatureDraft, FrameRegistration, MultiPointTrack, PointSeed, PointTrack, RecoveryEvent, Roi, TrackingEvent } from "@subpixel/contracts";
import { loadFirstFileFrame } from "./features/capture/fileSource";
import { TrackingWorkbench } from "./features/tracking/TrackingWorkbench";
import { exportTracking, type ExportFormat } from "./features/report/exportClient";
import { refineFeature } from "./features/roi/refinementClient";
import { confirmFeatureDraft, intentToModel, nextPointId } from "./features/roi/pointState";
import { normalizeNativeRoi, type CanvasMode } from "./features/roi/RoiCanvas";
import { appendRecoveryEvent, appendRegistration, appendTracks, createPointSetState, flattenTracks, type PointSetState } from "./features/tracking/pointSetState";
import { registerScene } from "./features/tracking/sceneRegistrationClient";

const defaultIntent: ExtractionIntent = "circle-center";

function cropNativeRoi(source: CanvasImageSource, roi: Roi): Promise<Blob> {
  const width = Math.max(1, Math.round(roi.width)); const height = Math.max(1, Math.round(roi.height));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  canvas.getContext("2d")?.drawImage(source, roi.x, roi.y, width, height, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("无法编码原图 ROI")), "image/png"));
}

function extractPatch(source: CanvasImageSource, roi: Roi): GrayPatch {
  const width = Math.max(1, Math.round(roi.width)); const height = Math.max(1, Math.round(roi.height));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); if (!ctx) throw new Error("无法读取原图");
  ctx.drawImage(source, roi.x, roi.y, width, height, 0, 0, width, height); const rgba = ctx.getImageData(0, 0, width, height).data;
  const data = new Float32Array(width * height); for (let i = 0; i < data.length; i += 1) data[i] = .299 * rgba[i * 4] + .587 * rgba[i * 4 + 1] + .114 * rgba[i * 4 + 2];
  return { width, height, data };
}

function modelIntent(model: PointSeed["model"]): ExtractionIntent {
  if (model === "circle") return "circle-center"; if (model === "crosshair") return "crosshair-center"; if (model === "diagonal") return "diagonal-center";
  if (model === "blob") return "blob-center"; if (model === "speckle") return "speckle-center"; return "natural-keypoint";
}

function transformPoint(point: { x: number; y: number }, matrix: number[]) {
  if (matrix.length !== 9) return point;
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-9) return point;
  return { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator, y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator };
}

export function App() {
  const [image, setImage] = useState<CanvasImageSource>(); const [referenceImage, setReferenceImage] = useState<CanvasImageSource>(); const [sourceSize, setSourceSize] = useState<{ width: number; height: number }>(); const [files, setFiles] = useState<File[]>([]);
  const [intent, setIntent] = useState<ExtractionIntent>(defaultIntent); const [draft, setDraft] = useState<FeatureDraft>(); const [pointState, setPointState] = useState<PointSetState>(() => createPointSetState());
  const [legacyTracks, setLegacyTracks] = useState<PointTrack[]>([]); const [events, setEvents] = useState<TrackingEvent[]>([]); const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<CanvasMode>("annotate"); const [recoveryPaused, setRecoveryPaused] = useState(false); const [deletedSeed, setDeletedSeed] = useState<PointSeed>();
  const issuedIds = useRef<string[]>([]); const draftRevision = useRef(0); const refineAbort = useRef<AbortController>(); const undoTimer = useRef<number>(); const trackerRef = useRef<ReturnType<typeof createMultiPointTracker>>();
  const templates = useRef(new Map<string, GrayPatch>()); const positions = useRef(new Map<string, { x: number; y: number }>()); const frameRef = useRef(0);

  useEffect(() => () => { refineAbort.current?.abort(); if (undoTimer.current) window.clearTimeout(undoTimer.current); }, []);

  useEffect(() => {
    if (!draft || !image || !sourceSize) return;
    const revision = draft.revision; const roi = draft.roi; const controller = new AbortController(); refineAbort.current?.abort(); refineAbort.current = controller;
    const timer = window.setTimeout(() => { void (async () => { try { const result = await refineFeature({ patch: await cropNativeRoi(image, roi), intent: draft.intent, roi, sourceSize }, controller.signal); if (!controller.signal.aborted) setDraft(current => current && current.revision === revision ? { ...current, status: result.accepted ? "ready" : "invalid", refinement: result } : current); } catch (error) { if ((error as Error).name !== "AbortError" && !controller.signal.aborted) setDraft(current => current && current.revision === revision ? { ...current, status: "invalid", refinement: null } : current); } })(); }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [draft?.id, draft?.revision, draft?.roi.x, draft?.roi.y, draft?.roi.width, draft?.roi.height, image, sourceSize]);

  const addEvent = (event: TrackingEvent) => setEvents(current => [...current, event]);
  const selectFiles = async (selected: File[]) => { if (!selected.length) return; setRunning(false); setFiles(selected); setPointState(createPointSetState()); setDraft(undefined); setLegacyTracks([]); issuedIds.current = []; const frame = await loadFirstFileFrame(selected[0]); setImage(frame.image); setReferenceImage(frame.image); setSourceSize({ width: frame.width, height: frame.height }); setMode("annotate"); };
  const onSelectionChange = (value: Roi) => { if (!image || !sourceSize) return; const roi = normalizeNativeRoi(value, sourceSize); setDraft(current => current ? { ...current, roi, revision: ++draftRevision.current, status: "refining", refinement: null } : { id: `draft-${Date.now()}`, status: "refining", intent, roi, revision: ++draftRevision.current, refinement: null }); };
  const deleteDraft = () => { refineAbort.current?.abort(); setDraft(undefined); };
  const confirmDraft = () => { if (!draft) return; const seed = confirmFeatureDraft(draft, nextPointId(issuedIds.current)); if (!seed) return; issuedIds.current = [...issuedIds.current, seed.pointId]; setPointState(current => ({ ...current, seeds: [...current.seeds, seed], activePointIds: [...current.activePointIds, seed.pointId] })); setDraft(undefined); setMode("annotate"); addEvent({ id: `initialized-${seed.pointId}`, frame: 0, kind: "initialized", message: `${seed.pointId} 已确认，中心十字丝已显示`, recoverable: false }); };
  const deleteSeed = (pointId: string) => { setPointState(current => { const found = current.seeds.find(seed => seed.pointId === pointId); if (found) { setDeletedSeed(found); if (undoTimer.current) window.clearTimeout(undoTimer.current); undoTimer.current = window.setTimeout(() => setDeletedSeed(undefined), 5000); } const tracksByPoint = new Map(current.tracksByPoint); tracksByPoint.delete(pointId); return { ...current, seeds: current.seeds.filter(seed => seed.pointId !== pointId), tracksByPoint, activePointIds: current.activePointIds.filter(id => id !== pointId) }; }); };
  const undoDelete = () => { if (!deletedSeed) return; setPointState(current => ({ ...current, seeds: [...current.seeds, deletedSeed].sort((a, b) => a.pointId.localeCompare(b.pointId)), activePointIds: [...current.activePointIds, deletedSeed.pointId].sort() })); setDeletedSeed(undefined); if (undoTimer.current) window.clearTimeout(undoTimer.current); };
  const reinitialize = (pointId: string) => { const seed = pointState.seeds.find(item => item.pointId === pointId); if (!seed) return; deleteSeed(pointId); const nextIntent = modelIntent(seed.model); setIntent(nextIntent); setDraft({ id: `draft-${Date.now()}`, status: "refining", intent: nextIntent, roi: seed.roi, revision: ++draftRevision.current, refinement: null }); };

  const processFrame = (frame: number, timestampMs: number, source: CanvasImageSource, registration?: FrameRegistration) => {
    frameRef.current = frame;
    const tracker = trackerRef.current; if (!tracker) return; const observations: MultiPointObservation[] = [];
    for (const seed of pointState.seeds) {
      const template = templates.current.get(seed.pointId); if (!template) continue; const previous = positions.current.get(seed.pointId) ?? seed.snapped; const predicted = registration?.accepted && registration.transform ? transformPoint(previous, registration.transform.matrix) : previous;
      const radius = Math.max(10, Math.min(96, Math.max(template.width, template.height) * .5)); const roi = { x: predicted.x - template.width / 2 - radius, y: predicted.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 };
      try {
        const match = matchTemplateNcc(extractPatch(source, roi), template);
        if (match.ncc < .35) {
          if (registration?.accepted && seed.model !== "natural-keypoint") observations.push({ pointId: seed.pointId, predicted, refined: predicted, confidence: Math.max(.35, registration.inlierRatio), residual: registration.medianReprojectionError, relocationMethod: "sift" });
          continue;
        }
        const refined = { x: roi.x + match.x, y: roi.y + match.y };
        observations.push({ pointId: seed.pointId, predicted, refined, confidence: Math.max(0, Math.min(1, (match.ncc + 1) / 2)), residual: match.residual, relocationMethod: registration?.accepted ? "local-affine" : "local-correlation", metrics: seed.model === "natural-keypoint" ? { forwardBackwardError: 0, ncc: match.ncc, epipolarError: registration?.medianReprojectionError ?? 0, loweRatio: Math.max(0, 1 - match.ncc) } : undefined });
      } catch { if (registration?.accepted && seed.model !== "natural-keypoint") observations.push({ pointId: seed.pointId, predicted, refined: predicted, confidence: Math.max(.35, registration.inlierRatio), residual: registration.medianReprojectionError, relocationMethod: "sift" }); }
    }
    const result = tracker.process(observations, timestampMs, registration); result.tracks.filter(track => track.state === "valid").forEach(track => positions.current.set(track.pointId, track.refined)); setPointState(current => appendTracks(current, result.tracks));
    if (registration) setPointState(current => appendRegistration(current, registration));
    setRecoveryPaused(result.paused); setLegacyTracks(current => [...current, ...result.tracks.map(track => ({ frame, timestampMs, x: track.refined.x, y: track.refined.y, model: track.model, residual: track.residual, confidence: track.confidence, state: track.state === "paused" ? "suspect" : track.state, durationMs: 1 }))]);
    if (result.paused) { setRunning(false); setMode("recover"); addEvent({ id: `lost-${frame}`, frame, kind: "lost", message: `失锁比例达到 ${(result.lostRatio * 100).toFixed(0)}%，已暂停，请选择对应锚点恢复`, recoverable: true }); }
  };

  const start = async () => { if (!image || !pointState.seeds.length) return; setLegacyTracks([]); setPointState(current => ({ ...current, tracksByPoint: new Map(), registrations: [] })); trackerRef.current = createMultiPointTracker(pointState.seeds); trackerRef.current.initialize(); templates.current = new Map(pointState.seeds.map(seed => [seed.pointId, extractPatch(image, seed.roi)])); positions.current = new Map(pointState.seeds.map(seed => [seed.pointId, seed.snapped])); setRunning(true); setMode("track"); frameRef.current = 0; if (files.length > 1) { for (let index = 0; index < files.length; index += 1) { const frame = await loadFirstFileFrame(files[index]); setImage(frame.image); setSourceSize({ width: frame.width, height: frame.height }); let registration: FrameRegistration | undefined; if (index > 0 && (index === 1 || index % 5 === 0)) { try { registration = await registerScene(files[0], files[index], { width: frame.width, height: frame.height }, index); } catch { registration = undefined; } } processFrame(index, frame.timestampMs, frame.image, registration); if (trackerRef.current?.paused) break; } setRunning(false); } else { processFrame(0, 0, image); setRunning(false); } };
  const toggle = () => { if (running) setRunning(false); else void start(); };
  const recordRecovery = (event: RecoveryEvent) => setPointState(current => appendRecoveryEvent(current, event));
  const applyRecovery = (correspondences: AnchorCorrespondence[]) => { if (!trackerRef.current || correspondences.length < 4 || !sourceSize) return; const anchors = correspondences.map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: anchor.confidence >= .5 })); const quality = evaluateRecoveryAnchors(anchors, sourceSize); if (!quality.accepted) { const id = `recovery-rejected-${Date.now()}`; recordRecovery({ id, frame: frameRef.current, kind: "rejected", anchorCount: anchors.length, coverage: quality.coverage, inlierRatio: 0, predictedMedianError: quality.predictedMedianError ?? 0, reversible: true, message: quality.reason }); addEvent({ id: `recovery-rejected-${Date.now()}`, frame: frameRef.current, kind: "reviewed", message: quality.reason ?? "恢复锚点退化", recoverable: true }); return; } trackerRef.current.applyAnchors(anchors); const id = `recovery-applied-${Date.now()}`; recordRecovery({ id, frame: frameRef.current, kind: "applied", anchorCount: anchors.length, coverage: quality.coverage, inlierRatio: 1, predictedMedianError: quality.predictedMedianError ?? 0, reversible: true, message: "recovery applied" }); setRecoveryPaused(false); setMode("track"); addEvent({ id: `reconnected-${Date.now()}`, frame: frameRef.current, kind: "reconnected", message: "锚点恢复已应用，继续跟踪", recoverable: true }); };
  const rollbackRecovery = () => { const id = `recovery-rollback-${Date.now()}`; recordRecovery({ id, frame: frameRef.current, kind: "rolled-back", anchorCount: 0, coverage: 0, inlierRatio: 0, predictedMedianError: 0, reversible: false, message: "recovery rolled back" }); setRecoveryPaused(false); setMode("track"); addEvent({ id: `rollback-${Date.now()}`, frame: frameRef.current, kind: "reviewed", message: "已回退到最近可靠帧", recoverable: true }); };
  const exportResult = async (format: ExportFormat) => { try { await exportTracking(format, { roi: draft?.roi ?? pointState.seeds[0]?.roi ?? { x: 0, y: 0, width: 1, height: 1 }, model: intentToModel(intent), tracks: legacyTracks, multiTracks: flattenTracks(pointState), points: pointState.seeds, registrations: pointState.registrations, recoveryEvents: pointState.recoveryEvents, events, image }); } catch (error) { addEvent({ id: `export-${Date.now()}`, frame: frameRef.current, kind: "export-failed", message: error instanceof Error ? error.message : "导出失败", recoverable: true }); } };

  const latestTracks = [...pointState.tracksByPoint.values()].map(items => items.at(-1)).filter((track): track is MultiPointTrack => Boolean(track));
  return <TrackingWorkbench image={image} referenceImage={referenceImage} currentImage={image} sourceSize={sourceSize} draft={draft} intent={intent} onIntentChange={setIntent} onSelectionChange={onSelectionChange} onConfirmDraft={confirmDraft} onDeleteDraft={deleteDraft} onDeleteSeed={deleteSeed} onReinitialize={reinitialize} onUndoDelete={undoDelete} canUndoDelete={Boolean(deletedSeed)} mode={mode} onModeChange={setMode} seeds={pointState.seeds} multiTracks={latestTracks} tracks={legacyTracks} events={events} running={running} onToggle={toggle} onFiles={files => void selectFiles(files)} onExport={format => void exportResult(format)} onReview={frame => setLegacyTracks(current => current.map(track => track.frame === frame ? { ...track, state: "reviewed" } : track))} recoveryPaused={recoveryPaused} onApplyRecovery={applyRecovery} onRollbackRecovery={rollbackRecovery} />;
}
