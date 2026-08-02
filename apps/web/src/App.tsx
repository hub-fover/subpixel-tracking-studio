import { useEffect, useRef, useState } from "react";
import { createMultiPointTracker, evaluateRecoveryAnchors, type GrayPatch } from "@subpixel/algorithms";
import type { AnchorCorrespondence, CameraSession, ExtractionIntent, FeatureDraft, FrameRegistration, MultiPointTrack, PointSeed, PointTrack, RecoveryEvent, RiskNotice, Roi, TrackingEvent } from "@subpixel/contracts";
import { cameraSource, chooseRecordingMimeType, type CameraFacingMode } from "./features/capture/cameraSource";
import { loadFirstFileFrame } from "./features/capture/fileSource";
import { TrackingWorkbench } from "./features/tracking/TrackingWorkbench";
import { exportTracking, type ExportFormat } from "./features/report/exportClient";
import { confirmFeatureDraft, intentToModel, nextPointId } from "./features/roi/pointState";
import { normalizeNativeRoi, type CanvasMode } from "./features/roi/RoiCanvas";
import { appendRecoveryEvent, appendRegistration, appendRiskNotice, appendTracks, createPointSetState, flattenTracks, summarizeProcessing, type PointSetState } from "./features/tracking/pointSetState";
import { extractNativePatch } from "./features/local/frameUtils";
import { LocalAlgorithmEngine, type BrowserFrame } from "./features/local/localAlgorithmEngine";
import { LocalWorkerClient } from "./features/local/localWorkerClient";

const defaultIntent: ExtractionIntent = "circle-center";

function modelIntent(model: PointSeed["model"]): ExtractionIntent {
  if (model === "circle") return "circle-center";
  if (model === "crosshair") return "crosshair-center";
  if (model === "diagonal") return "diagonal-center";
  if (model === "blob") return "blob-center";
  if (model === "speckle") return "speckle-center";
  return "natural-keypoint";
}

export function App() {
  const [image, setImage] = useState<CanvasImageSource>();
  const [referenceImage, setReferenceImage] = useState<CanvasImageSource>();
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number }>();
  const [files, setFiles] = useState<File[]>([]);
  const [intent, setIntent] = useState<ExtractionIntent>(defaultIntent);
  const [draft, setDraft] = useState<FeatureDraft>();
  const [pointState, setPointState] = useState<PointSetState>(() => createPointSetState());
  const [legacyTracks, setLegacyTracks] = useState<PointTrack[]>([]);
  const [events, setEvents] = useState<TrackingEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<CanvasMode>("annotate");
  const [recoveryPaused, setRecoveryPaused] = useState(false);
  const [deletedSeed, setDeletedSeed] = useState<PointSeed>();
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("environment");
  const [cameraActive, setCameraActive] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const seedsRef = useRef<PointSeed[]>([]);
  const trackerRef = useRef<ReturnType<typeof createMultiPointTracker>>();
  const templatesRef = useRef(new Map<string, GrayPatch>());
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const frameRef = useRef(0);
  const runningRef = useRef(false);
  const engineRef = useRef(new LocalAlgorithmEngine());
  const localWorkerRef = useRef<LocalWorkerClient>();
  const referenceFrameRef = useRef<BrowserFrame>();
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraSourceRef = useRef<Awaited<ReturnType<typeof cameraSource>>>();
  const cameraTokenRef = useRef(0);
  const recorderRef = useRef<MediaRecorder>();
  const recordingChunksRef = useRef<Blob[]>([]);
  const undoTimerRef = useRef<number>();
  const issuedIdsRef = useRef<string[]>([]);
  const displayedImageRef = useRef<CanvasImageSource>();
  const latencyRef = useRef<number[]>([]);
  const processedFrameCountRef = useRef(0);
  const droppedFrameCountRef = useRef(0);
  const lastProcessedAtRef = useRef(0);

  useEffect(() => { seedsRef.current = pointState.seeds; }, [pointState.seeds]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { localWorkerRef.current = new LocalWorkerClient(); return () => localWorkerRef.current?.dispose(); }, []);
  useEffect(() => () => { cameraTokenRef.current += 1; cameraSourceRef.current?.stop(); recorderRef.current?.stop(); if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current); const previous = displayedImageRef.current; if (previous && "close" in previous) (previous as ImageBitmap).close(); }, []);
  useEffect(() => { if (image && image !== displayedImageRef.current) { const previous = displayedImageRef.current; displayedImageRef.current = image; const protectedImage = referenceFrameRef.current?.image; if (previous && previous !== protectedImage && "close" in previous) (previous as ImageBitmap).close(); } }, [image]);
  useEffect(() => {
    const onOrientationChange = () => addRisk({ code: "camera.orientation-changed", severity: "warning", frame: frameRef.current, message: "屏幕方向发生变化，已保持原生坐标；请确认 ROI 仍覆盖目标", action: "reselect-roi", recoverable: true });
    window.addEventListener("orientationchange", onOrientationChange);
    const battery = (navigator as Navigator & { getBattery?: () => Promise<{ level: number; addEventListener?: (name: string, handler: () => void) => void }> }).getBattery?.();
    void battery?.then(info => { const check = () => { if (info.level <= .15) addRisk({ code: "device.low-battery", severity: "warning", frame: frameRef.current, message: "设备电量较低，长时间处理可能降帧", action: "pause", recoverable: true }); }; check(); info.addEventListener?.("levelchange", check); });
    return () => window.removeEventListener("orientationchange", onOrientationChange);
  }, []);

  const addRisk = (input: Omit<RiskNotice, "id" | "createdAt">) => setPointState(state => appendRiskNotice(state, { ...input, id: `${input.code}-${input.frame}-${input.pointId ?? "all"}`, createdAt: Date.now() }));
  const addEvent = (event: TrackingEvent) => setEvents(current => [...current, event]);
  const reportEngineStatus = (status: ReturnType<LocalAlgorithmEngine["load"]> extends Promise<infer Result> ? Result : never) => {
    if (status.opencv === "unavailable") addRisk({ code: "opencv.load-failed", severity: "warning", frame: frameRef.current, message: "OpenCV.js 加载失败，将使用 TypeScript 小位移路径", action: "continue-local", recoverable: true });
    else if (!status.capabilities.registration || !status.capabilities.descriptors) addRisk({ code: "opencv.feature-unavailable", severity: "warning", frame: frameRef.current, message: "当前 OpenCV.js 构建缺少 SIFT/ORB 或单应配准能力", action: "continue-local", recoverable: true });
  };

  useEffect(() => {
    if (!draft || !image || !sourceSize) return;
    const revision = draft.revision;
    const timer = window.setTimeout(() => {
      const frame: BrowserFrame = { frame: frameRef.current, timestampMs: performance.now(), width: sourceSize.width, height: sourceSize.height, source: cameraActive ? "camera" : "image", image };
      void (async () => {
        try {
          const patch = extractNativePatch(frame.image, draft.roi);
          const result = await (localWorkerRef.current?.refine(frame, patch, draft.roi, draft.intent) ?? Promise.resolve(engineRef.current.refine(frame, draft.roi, draft.intent)));
          setDraft(current => current && current.revision === revision ? { ...current, status: result.accepted ? "ready" : "invalid", refinement: result } : current);
          if (!result.accepted) addRisk({ code: result.reason === "refinement.invalid-roi" ? "refinement.invalid-roi" : "refinement.gate-failed", severity: "warning", frame: frame.frame, message: result.reason ?? "ROI refinement rejected", action: "reselect-roi", recoverable: true });
        } catch (error) {
          setDraft(current => current && current.revision === revision ? { ...current, status: "invalid", refinement: null } : current);
          addRisk({ code: "refinement.gate-failed", severity: "error", frame: frame.frame, message: error instanceof Error ? error.message : "Local refinement failed", action: "retry", recoverable: true });
        }
      })();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [cameraActive, draft?.id, draft?.revision, draft?.roi.x, draft?.roi.y, draft?.roi.width, draft?.roi.height, image, sourceSize]);

  const processFrame = (frame: BrowserFrame, registration?: FrameRegistration) => {
    const startedAt = performance.now();
    frameRef.current = frame.frame;
    const tracker = trackerRef.current;
    if (!tracker) return;
    const result = engineRef.current.track(frame, seedsRef.current, { templates: templatesRef.current, positions: positionsRef.current, registration, tracker });
    result.tracks.filter(track => track.state === "lost" || track.state === "suspect").forEach(track => addRisk({ code: "tracking.identity-gate-failed", severity: track.state === "lost" ? "error" : "warning", frame: frame.frame, pointId: track.pointId, message: `${track.pointId} identity gate failed`, action: "select-anchors", recoverable: true }));
    result.tracks.filter(track => track.state === "valid").forEach(track => positionsRef.current.set(track.pointId, track.refined));
    setPointState(state => registration ? appendRegistration(appendTracks(state, result.tracks), registration) : appendTracks(state, result.tracks));
    setLegacyTracks(current => [...current, ...result.tracks.map(track => ({ frame: track.frame, timestampMs: track.timestampMs, x: track.refined.x, y: track.refined.y, model: track.model, residual: track.residual, confidence: track.confidence, state: track.state === "paused" ? "suspect" : track.state, durationMs: 1 }))]);
    const latency = performance.now() - startedAt;
    latencyRef.current = [...latencyRef.current.slice(-59), latency];
    processedFrameCountRef.current += 1;
    const processingStats = summarizeProcessing({ processedFrames: processedFrameCountRef.current, droppedFrames: droppedFrameCountRef.current, latencies: latencyRef.current, nativeWidth: frame.width, nativeHeight: frame.height, engine: engineRef.current.engineStatus.opencv === "ready" ? "opencv-js" : "typescript" });
    setPointState(state => ({ ...state, processingStats }));
    if (processingStats.p95LatencyMs > 1000 / 15) addRisk({ code: "tracking.frame-budget", severity: "warning", frame: frame.frame, message: `处理 P95 ${processingStats.p95LatencyMs.toFixed(1)} ms，已跳帧保持原始分辨率`, action: "pause", recoverable: true });
    if (result.paused) { runningRef.current = false; setRunning(false); setMode("recover"); setRecoveryPaused(true); addRisk({ code: "tracking.lost", severity: "error", frame: frame.frame, message: `Lost ratio ${(result.lostRatio * 100).toFixed(0)}%; tracking paused`, action: "select-anchors", recoverable: true }); addEvent({ id: `lost-${frame.frame}`, frame: frame.frame, kind: "lost", message: "Tracking paused; select recovery anchors", recoverable: true }); }
  };

  const initializeTrackingFor = (baseImage: CanvasImageSource, size: { width: number; height: number }, source: BrowserFrame["source"]) => {
    if (!seedsRef.current.length) return false;
    trackerRef.current = createMultiPointTracker(seedsRef.current); trackerRef.current.initialize();
    templatesRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, extractNativePatch(baseImage, seed.roi)]));
    positionsRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, seed.snapped]));
    referenceFrameRef.current = { frame: 0, timestampMs: 0, width: size.width, height: size.height, source, image: baseImage };
    frameRef.current = 0; runningRef.current = true; setLegacyTracks([]); setPointState(state => ({ ...state, tracksByPoint: new Map(), registrations: [] })); setMode("track"); setRunning(true); return true;
  };

  const initializeTracking = () => image && sourceSize ? initializeTrackingFor(image, sourceSize, cameraActive ? "camera" : "image") : false;

  const processFiles = async (selected: File[]) => {
    for (let index = 0; index < selected.length; index += 1) {
      const loaded = await loadFirstFileFrame(selected[index]);
      const frame: BrowserFrame = { frame: index, timestampMs: loaded.timestampMs, width: loaded.width, height: loaded.height, source: selected[index].type.startsWith("video/") ? "video" : "image", image: loaded.image };
      setImage(loaded.image); setSourceSize({ width: loaded.width, height: loaded.height });
      const registration = index > 0 && referenceFrameRef.current && (index === 1 || index % 5 === 0) ? engineRef.current.register(referenceFrameRef.current, frame, index) : undefined;
      processFrame(frame, registration);
      if (registration && !registration.accepted) addRisk({ code: "registration.rejected", severity: "warning", frame: index, message: registration.reason ?? "Scene registration rejected", action: "select-anchors", recoverable: true });
      if (trackerRef.current?.paused) break;
    }
    runningRef.current = false; setRunning(false);
  };

  const selectFiles = async (selected: File[]) => {
    if (!selected.length) return;
    cameraSourceRef.current?.stop(); setCameraActive(false); setRunning(false); setFiles(selected); setPointState(createPointSetState()); setDraft(undefined); setLegacyTracks([]); issuedIdsRef.current = [];
    const first = await loadFirstFileFrame(selected[0]); setImage(first.image); setReferenceImage(first.image); setSourceSize({ width: first.width, height: first.height }); setMode("annotate");
    void engineRef.current.load().then(reportEngineStatus);
  };

  const openCamera = async (requestedFacingMode: CameraFacingMode = facingMode) => {
    const video = cameraVideoRef.current;
    if (!video) return;
    if (cameraSourceRef.current) { cameraTokenRef.current += 1; cameraSourceRef.current.stop(); cameraSourceRef.current = undefined; setCameraActive(false); setPointState(state => ({ ...state, cameraSession: { ...state.cameraSession, status: "stopped", recording: false } })); return; }
    setPointState(state => ({ ...state, cameraSession: { ...state.cameraSession, status: "requesting", facingMode: requestedFacingMode, error: null } }));
    void engineRef.current.load().then(reportEngineStatus);
    try {
      const source = await cameraSource(video, requestedFacingMode); cameraSourceRef.current = source; setCameraActive(true); const token = ++cameraTokenRef.current;
      setPointState(state => ({ ...state, cameraSession: { status: "ready", facingMode: requestedFacingMode, nativeWidth: video.videoWidth, nativeHeight: video.videoHeight, recording: false, error: null }, processingStats: { ...state.processingStats, nativeWidth: video.videoWidth, nativeHeight: video.videoHeight } }));
      void (async () => {
        for await (const captured of source) {
          if (token !== cameraTokenRef.current) break;
          const frame: BrowserFrame = { frame: frameRef.current + 1, timestampMs: captured.timestampMs, width: captured.width, height: captured.height, source: "camera", image: captured.image };
          setImage(captured.image); setSourceSize({ width: captured.width, height: captured.height });
          if (!referenceFrameRef.current) { referenceFrameRef.current = frame; setReferenceImage(captured.image); }
          if (runningRef.current && trackerRef.current) {
            if (captured.timestampMs - lastProcessedAtRef.current < 1000 / 15) { droppedFrameCountRef.current += 1; continue; }
            lastProcessedAtRef.current = captured.timestampMs;
            const registration = frame.frame % 5 === 0 && referenceFrameRef.current ? engineRef.current.register(referenceFrameRef.current, frame, frame.frame) : undefined;
            processFrame(frame, registration);
            if (registration && !registration.accepted) addRisk({ code: "registration.rejected", severity: "warning", frame: frame.frame, message: registration.reason ?? "Scene registration rejected", action: "select-anchors", recoverable: true });
          }
        }
      })();
    } catch (error) {
      const permissionDenied = (error as { code?: string }).code === "input.permission";
      const unsupported = (error as { code?: string }).code === "input.unsupported";
      const noDevice = (error as { code?: string }).code === "input.no-device";
      const secureContext = unsupported && /HTTPS|secure/i.test(error instanceof Error ? error.message : "");
      setPointState(state => ({ ...state, cameraSession: { ...state.cameraSession, status: permissionDenied ? "denied" : unsupported ? "unsupported" : "error", error: error instanceof Error ? error.message : "Camera unavailable" } }));
      addRisk({ code: permissionDenied ? "camera.permission-denied" : secureContext ? "secure-context.required" : unsupported ? "camera.unsupported" : noDevice ? "camera.no-device" : "camera.unavailable", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "Camera unavailable", action: permissionDenied ? "open-settings" : "retry", recoverable: true });
    }
  };

  const toggleRecording = () => {
    const stream = cameraSourceRef.current?.stream;
    if (!stream || typeof MediaRecorder === "undefined") { addRisk({ code: "recording.unsupported", severity: "warning", frame: frameRef.current, message: "Recording is not supported by this browser", action: "continue-local", recoverable: true }); return; }
    if (recorderRef.current) { recorderRef.current.stop(); return; }
    const mimeType = chooseRecordingMimeType();
    if (!mimeType) { addRisk({ code: "recording.unsupported", severity: "warning", frame: frameRef.current, message: "No supported recording format", action: "continue-local", recoverable: true }); return; }
    const recorder = new MediaRecorder(stream, { mimeType }); recordingChunksRef.current = [];
    recorder.ondataavailable = event => { if (event.data.size) recordingChunksRef.current.push(event.data); };
    recorder.onstop = () => { const blob = new Blob(recordingChunksRef.current, { type: mimeType }); recorderRef.current = undefined; setRecordingActive(false); setPointState(state => ({ ...state, recording: { active: false, mimeType, blob }, cameraSession: { ...state.cameraSession, recording: false } })); };
    recorder.start(500); recorderRef.current = recorder; setRecordingActive(true); setPointState(state => ({ ...state, recording: { active: true, mimeType, blob: null }, cameraSession: { ...state.cameraSession, recording: true } }));
  };

  const refineRecording = async () => {
    const blob = pointState.recording.blob;
    if (!blob || !seedsRef.current.length) return;
    const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.src = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => { video.onloadedmetadata = () => resolve(); video.onerror = () => reject(new Error("录制文件无法解码")); });
      const size = { width: video.videoWidth, height: video.videoHeight }; if (!size.width || !size.height) throw new Error("录制文件缺少原生尺寸");
      await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("无法定位录制帧")); video.currentTime = 0; });
      const firstImage = typeof createImageBitmap === "function" ? await createImageBitmap(video) : video;
      setImage(video); setSourceSize(size); setReferenceImage(firstImage); initializeTrackingFor(firstImage, size, "video");
      for (let index = 1, timestamp = 1 / 15; timestamp < video.duration && runningRef.current; index += 1, timestamp += 1 / 15) {
        await new Promise<void>((resolve, reject) => { video.onseeked = () => resolve(); video.onerror = () => reject(new Error("无法定位录制帧")); video.currentTime = timestamp; });
        const currentImage = typeof createImageBitmap === "function" ? await createImageBitmap(video) : video;
        const frame: BrowserFrame = { frame: index, timestampMs: timestamp * 1000, width: size.width, height: size.height, source: "video", image: currentImage };
        const registration = index % 5 === 0 && referenceFrameRef.current ? engineRef.current.register(referenceFrameRef.current, frame, index) : undefined;
        processFrame(frame, registration);
        if (registration && !registration.accepted) addRisk({ code: "registration.rejected", severity: "warning", frame: index, message: registration.reason ?? "Scene registration rejected", action: "select-anchors", recoverable: true });
        if (currentImage !== video && "close" in currentImage) (currentImage as ImageBitmap).close();
        if (trackerRef.current?.paused) break;
      }
    } catch (error) { addRisk({ code: "export.failed", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "录制精算失败", action: "retry", recoverable: true }); }
    finally { URL.revokeObjectURL(video.src); setRunning(false); }
  };

  const onSelectionChange = (value: Roi) => { if (!image || !sourceSize) return; const roi = normalizeNativeRoi(value, sourceSize); setDraft(current => current ? { ...current, roi, revision: Date.now(), status: "refining", refinement: null } : { id: `draft-${Date.now()}`, status: "refining", intent, roi, revision: Date.now(), refinement: null }); };
  const confirmDraft = () => { if (!draft) return; const seed = confirmFeatureDraft(draft, nextPointId(issuedIdsRef.current)); if (!seed) return; issuedIdsRef.current = [...issuedIdsRef.current, seed.pointId]; setPointState(state => ({ ...state, seeds: [...state.seeds, seed], activePointIds: [...state.activePointIds, seed.pointId] })); setDraft(undefined); setMode("annotate"); addEvent({ id: `initialized-${seed.pointId}`, frame: 0, kind: "initialized", message: `${seed.pointId} confirmed`, recoverable: false }); };
  const deleteDraft = () => setDraft(undefined);
  const deleteSeed = (pointId: string) => setPointState(state => { const found = state.seeds.find(seed => seed.pointId === pointId); if (found) { setDeletedSeed(found); if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current); undoTimerRef.current = window.setTimeout(() => setDeletedSeed(undefined), 5000); } const tracksByPoint = new Map(state.tracksByPoint); tracksByPoint.delete(pointId); return { ...state, seeds: state.seeds.filter(seed => seed.pointId !== pointId), tracksByPoint, activePointIds: state.activePointIds.filter(id => id !== pointId) }; });
  const undoDelete = () => { if (!deletedSeed) return; setPointState(state => ({ ...state, seeds: [...state.seeds, deletedSeed].sort((a, b) => a.pointId.localeCompare(b.pointId)), activePointIds: [...state.activePointIds, deletedSeed.pointId].sort() })); setDeletedSeed(undefined); };
  const reinitialize = (pointId: string) => { const seed = pointState.seeds.find(item => item.pointId === pointId); if (!seed) return; deleteSeed(pointId); const nextIntent = modelIntent(seed.model); setIntent(nextIntent); setDraft({ id: `draft-${Date.now()}`, status: "refining", intent: nextIntent, roi: seed.roi, revision: Date.now(), refinement: null }); };
  const toggleTracking = async () => { if (running) { runningRef.current = false; setRunning(false); return; } await engineRef.current.load(); if (!initializeTracking()) return; if (!cameraActive) await processFiles(files); };
  const applyRecovery = (correspondences: AnchorCorrespondence[]) => { if (!trackerRef.current || correspondences.length < 4 || !sourceSize) return; const anchors = correspondences.map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: anchor.confidence >= .5 })); const quality = evaluateRecoveryAnchors(anchors, sourceSize); if (!quality.accepted) { addRisk({ code: "tracking.lost", severity: "error", frame: frameRef.current, message: quality.reason ?? "Recovery anchors rejected", action: "select-anchors", recoverable: true }); return; } trackerRef.current.applyAnchors(anchors); const event: RecoveryEvent = { id: `recovery-applied-${Date.now()}`, frame: frameRef.current, kind: "applied", anchorCount: anchors.length, coverage: quality.coverage, inlierRatio: 1, predictedMedianError: quality.predictedMedianError ?? 0, reversible: true, message: "recovery applied" }; setPointState(state => appendRecoveryEvent(state, event)); setRecoveryPaused(false); runningRef.current = true; setRunning(true); setMode("track"); };
  const rollbackRecovery = () => { setPointState(state => appendRecoveryEvent(state, { id: `recovery-rollback-${Date.now()}`, frame: frameRef.current, kind: "rolled-back", anchorCount: 0, coverage: 0, inlierRatio: 0, predictedMedianError: 0, reversible: false, message: "recovery rolled back" })); setRecoveryPaused(false); runningRef.current = true; setRunning(true); setMode("track"); };
  const exportResult = async (format: ExportFormat) => { try { await exportTracking(format, { roi: draft?.roi ?? pointState.seeds[0]?.roi ?? { x: 0, y: 0, width: 1, height: 1 }, model: intentToModel(intent), tracks: legacyTracks, multiTracks: flattenTracks(pointState), points: pointState.seeds, registrations: pointState.registrations, recoveryEvents: pointState.recoveryEvents, riskNotices: pointState.riskNotices, processingStats: pointState.processingStats, events, image }); } catch (error) { addRisk({ code: "export.failed", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "Export failed", action: "export-current", recoverable: true }); } };

  const latestTracks = [...pointState.tracksByPoint.values()].map(items => items.at(-1)).filter((track): track is MultiPointTrack => Boolean(track));
  const cameraSession: CameraSession = pointState.cameraSession;
  return <div><video ref={cameraVideoRef} className="camera-video-source" muted playsInline aria-hidden="true" /><TrackingWorkbench image={image} referenceImage={referenceImage} currentImage={image} sourceSize={sourceSize} draft={draft} intent={intent} onIntentChange={setIntent} onSelectionChange={onSelectionChange} onConfirmDraft={confirmDraft} onDeleteDraft={deleteDraft} onDeleteSeed={deleteSeed} onReinitialize={reinitialize} onUndoDelete={undoDelete} canUndoDelete={Boolean(deletedSeed)} mode={mode} onModeChange={setMode} seeds={pointState.seeds} multiTracks={latestTracks} tracks={legacyTracks} events={events} running={running} onToggle={toggleTracking} onFiles={selectFiles} onExport={exportResult} onReview={frame => setLegacyTracks(current => current.map(track => track.frame === frame ? { ...track, state: "reviewed" } : track))} recoveryPaused={recoveryPaused} onApplyRecovery={applyRecovery} onRollbackRecovery={rollbackRecovery} onOpenCamera={() => void openCamera()} cameraActive={cameraActive} cameraSession={cameraSession} facingMode={facingMode} onSwitchCamera={() => { const next = facingMode === "environment" ? "user" : "environment"; setFacingMode(next); cameraSourceRef.current?.stop(); cameraSourceRef.current = undefined; if (cameraActive) window.setTimeout(() => void openCamera(next), 0); }} recordingActive={recordingActive} onToggleRecording={toggleRecording} recordingReady={Boolean(pointState.recording.blob)} onRefineRecording={() => void refineRecording()} riskNotices={pointState.riskNotices} processingStats={pointState.processingStats} /></div>;
}
