import { useEffect, useRef, useState } from "react";
import { createMultiPointTracker, evaluateRecoveryAnchors, type GrayPatch } from "@subpixel/algorithms";
import type { AnchorCorrespondence, CameraSession, ExtractionIntent, FeatureDraft, FrameRegistration, MultiPointTrack, PointSeed, PointTrack, RecoveryEvent, RiskNotice, Roi, TrackingEvent, ReportMetadata, QualityThresholds, ReportModel } from "@subpixel/contracts";
import { cameraSource, chooseRecordingMimeType, type CameraFacingMode } from "./features/capture/cameraSource";
import { loadFirstFileFrame, seekVideoFrame, snapshotVideoFrame, videoFrameTimes, type LoadedFileFrame } from "./features/capture/fileSource";
import { TrackingWorkbench } from "./features/tracking/TrackingWorkbench";
import { exportTracking, type ExportFormat } from "./features/report/exportClient";
import { confirmFeatureDraft, intentToModel, nextPointId } from "./features/roi/pointState";
import { normalizeNativeRoi, type CanvasMode } from "./features/roi/RoiCanvas";
import { appendRecoveryEvent, appendRegistration, appendRiskNotice, appendTracks, clearRiskNotices, createPointSetState, flattenTracks, summarizeProcessing, type PointSetState } from "./features/tracking/pointSetState";
import { extractNativePatch } from "./features/local/frameUtils";
import { LocalAlgorithmEngine, type BrowserFrame, type LocalSearchRegion } from "./features/local/localAlgorithmEngine";
import { LocalWorkerClient } from "./features/local/localWorkerClient";
import { refinementReasonMessage } from "./features/roi/refinementMessages";
import { buildReportModel, DEFAULT_QUALITY_THRESHOLDS } from "./features/report/reportModel";

const defaultIntent: ExtractionIntent = "circle-center";

function modelIntent(model: PointSeed["model"]): ExtractionIntent {
  if (model === "circle") return "circle-center";
  if (model === "crosshair") return "crosshair-center";
  if (model === "diagonal") return "diagonal-center";
  if (model === "blob") return "blob-center";
  if (model === "speckle") return "speckle-center";
  return "natural-keypoint";
}

export function trackingTemplateRoi(seed: PointSeed, size: { width: number; height: number }) {
  if (seed.model !== "natural-keypoint") return normalizeNativeRoi(seed.roi, size);
  let patchSize = Math.max(9, Math.min(31, Math.floor(Math.min(seed.roi.width, seed.roi.height))));
  if (patchSize % 2 === 0) patchSize -= 1;
  return normalizeNativeRoi({ x: Math.round(seed.snapped.x - (patchSize - 1) / 2), y: Math.round(seed.snapped.y - (patchSize - 1) / 2), width: patchSize, height: patchSize }, size);
}

export function isCurrentRefinementRevision(responseRevision: number, currentRevision: number) {
  return responseRevision === currentRevision;
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
  const [reportModel, setReportModel] = useState<ReportModel>();
  const [reportOpen, setReportOpen] = useState(false);
  const seedsRef = useRef<PointSeed[]>([]);
  const trackerRef = useRef<ReturnType<typeof createMultiPointTracker>>();
  const templatesRef = useRef(new Map<string, GrayPatch>());
  const previousSearchesRef = useRef(new Map<string, LocalSearchRegion>());
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const frameRef = useRef(0);
  const runningRef = useRef(false);
  const engineRef = useRef(new LocalAlgorithmEngine());
  const localWorkerRef = useRef<LocalWorkerClient>();
  const referenceFrameRef = useRef<BrowserFrame>();
  const refinementImageRef = useRef<CanvasImageSource>();
  const refinementImageOwnedRef = useRef(false);
  const refinementTokenRef = useRef(0);
  const revisionRef = useRef(0);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const selectedFilePreviewRef = useRef<LoadedFileFrame>();
  const cameraSourceRef = useRef<Awaited<ReturnType<typeof cameraSource>>>();
  const cameraTokenRef = useRef(0);
  const recorderRef = useRef<MediaRecorder>();
  const recordingStartedAtRef = useRef(0);
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
  useEffect(() => () => { cameraTokenRef.current += 1; cameraSourceRef.current?.stop(); selectedFilePreviewRef.current?.release?.(); recorderRef.current?.stop(); releaseRefinementImage(); if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current); const previous = displayedImageRef.current; if (previous && "close" in previous) (previous as ImageBitmap).close(); }, []);
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

  const releaseRefinementImage = () => {
    const source = refinementImageRef.current;
    if (source && refinementImageOwnedRef.current && "close" in source) (source as ImageBitmap).close();
    refinementImageRef.current = undefined;
    refinementImageOwnedRef.current = false;
  };

  const nextRevision = () => {
    revisionRef.current += 1;
    return revisionRef.current;
  };

  const snapshotRefinementImage = async (source: CanvasImageSource) => {
    if (typeof createImageBitmap !== "function") return { image: source, owned: false };
    try {
      return { image: await createImageBitmap(source as ImageBitmapSource), owned: true };
    } catch {
      return { image: source, owned: false };
    }
  };

  useEffect(() => {
    // Keep refinement on one native frame. Live camera frames would cancel the debounce.
    const refinementImage = refinementImageRef.current;
    if (!draft || !refinementImage || !sourceSize) return;
    const revision = draft.revision;
    const token = refinementTokenRef.current;
    const timer = window.setTimeout(() => {
      const frame: BrowserFrame = { frame: frameRef.current, timestampMs: performance.now(), width: sourceSize.width, height: sourceSize.height, source: cameraActive ? "camera" : "image", image: refinementImage };
      void (async () => {
        try {
          const patch = extractNativePatch(frame.image, draft.roi);
          const result = engineRef.current.engineStatus.opencv === "ready"
            ? engineRef.current.refine(frame, draft.roi, draft.intent)
            : await (localWorkerRef.current?.refine(frame, patch, draft.roi, draft.intent) ?? Promise.resolve(engineRef.current.refine(frame, draft.roi, draft.intent)));
          if (!isCurrentRefinementRevision(revision, revisionRef.current) || token !== refinementTokenRef.current) return;
          setDraft(current => current && current.revision === revision ? { ...current, status: result.accepted ? "ready" : "invalid", refinement: result } : current);
          if (!result.accepted) addRisk({ code: result.reason === "refinement.invalid-roi" ? "refinement.invalid-roi" : "refinement.gate-failed", severity: "warning", frame: frame.frame, message: refinementReasonMessage(result.reason), action: "reselect-roi", recoverable: true });
          else setPointState(state => clearRiskNotices(state, notice => notice.code.startsWith("refinement.")));
        } catch (error) {
          if (!isCurrentRefinementRevision(revision, revisionRef.current) || token !== refinementTokenRef.current) return;
          setDraft(current => current && current.revision === revision ? { ...current, status: "invalid", refinement: null } : current);
          addRisk({ code: "refinement.gate-failed", severity: "error", frame: frame.frame, message: error instanceof Error ? error.message : "Local refinement failed", action: "retry", recoverable: true });
        }
      })();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [cameraActive, draft?.id, draft?.revision, draft?.roi.x, draft?.roi.y, draft?.roi.width, draft?.roi.height, sourceSize?.width, sourceSize?.height]);

  const processFrame = (frame: BrowserFrame, registration?: FrameRegistration) => {
    const startedAt = performance.now();
    frameRef.current = frame.frame;
    const tracker = trackerRef.current;
    if (!tracker) return;
    const result = engineRef.current.track(frame, seedsRef.current, { templates: templatesRef.current, positions: positionsRef.current, previousSearches: previousSearchesRef.current, registration, tracker });
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
    if (result.paused) { const pauseMessage = registration?.accepted === false ? `场景配准失败：${registration.reason ?? "质量门控未通过"}` : `失锁比例 ${(result.lostRatio * 100).toFixed(0)}%，跟踪已暂停`; runningRef.current = false; setRunning(false); setMode("recover"); setRecoveryPaused(true); addRisk({ code: "tracking.lost", severity: "error", frame: frame.frame, message: pauseMessage, action: "select-anchors", recoverable: true }); addEvent({ id: `lost-${frame.frame}`, frame: frame.frame, kind: "lost", message: `${pauseMessage}；请选择恢复锚点`, recoverable: true }); }
  };

  const initializeTrackingFor = (baseImage: CanvasImageSource, size: { width: number; height: number }, source: BrowserFrame["source"]) => {
    if (!seedsRef.current.length) return false;
    trackerRef.current = createMultiPointTracker(seedsRef.current); trackerRef.current.initialize();
    templatesRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, extractNativePatch(baseImage, trackingTemplateRoi(seed, size))]));
    previousSearchesRef.current = new Map(seedsRef.current.map(seed => {
      const template = templatesRef.current.get(seed.pointId)!;
      const radius = seed.model === "natural-keypoint" ? Math.min(192, Math.max(24, Math.max(template.width, template.height) * 1.5)) : Math.max(10, Math.min(96, Math.max(template.width, template.height) * .5));
      const searchRoi = normalizeNativeRoi({ x: seed.snapped.x - template.width / 2 - radius, y: seed.snapped.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 }, size);
      return [seed.pointId, { patch: extractNativePatch(baseImage, searchRoi), roi: searchRoi }];
    }));
    positionsRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, seed.snapped]));
    referenceFrameRef.current = { frame: 0, timestampMs: 0, width: size.width, height: size.height, source, image: baseImage };
    frameRef.current = 0; runningRef.current = true; setLegacyTracks([]); setPointState(state => ({ ...state, tracksByPoint: new Map(), registrations: [] })); setMode("track"); setRunning(true); return true;
  };

  const initializeTracking = () => image && sourceSize ? initializeTrackingFor(image, sourceSize, cameraActive ? "camera" : files[0]?.type.startsWith("video/") ? "video" : "image") : false;

  const processFiles = async (selected: File[]) => {
    let frameNumber = 0;
    for (let fileIndex = 0; fileIndex < selected.length && runningRef.current; fileIndex += 1) {
      const isPreview = fileIndex === 0 && Boolean(selectedFilePreviewRef.current);
      const loaded = isPreview ? selectedFilePreviewRef.current! : await loadFirstFileFrame(selected[fileIndex]);
      if (loaded.video) {
        let latestPreview: CanvasImageSource = loaded.image;
        for (const timeSeconds of videoFrameTimes(loaded.durationMs ? loaded.durationMs / 1000 : loaded.video.duration, 15)) {
          if (!runningRef.current) break;
          const currentImage = timeSeconds === 0 ? loaded.image : (await seekVideoFrame(loaded.video, timeSeconds), await snapshotVideoFrame(loaded.video));
          if (latestPreview !== loaded.image && latestPreview !== currentImage && "close" in latestPreview) (latestPreview as ImageBitmap).close();
          latestPreview = currentImage;
          const frame: BrowserFrame = { frame: frameNumber, timestampMs: timeSeconds * 1000, width: loaded.width, height: loaded.height, source: "video", image: currentImage };
          const registration = frameNumber > 0 && frameNumber % 5 === 0 && referenceFrameRef.current ? engineRef.current.register(referenceFrameRef.current, frame, frameNumber) : undefined;
          processFrame(frame, registration);
          if (registration && !registration.accepted) addRisk({ code: "registration.rejected", severity: "warning", frame: frameNumber, message: registration.reason ?? "场景配准被拒绝", action: "select-anchors", recoverable: true });
          frameNumber += 1;
          if (trackerRef.current?.paused) break;
        }
        setImage(latestPreview); setSourceSize({ width: loaded.width, height: loaded.height });
      } else {
        const frame: BrowserFrame = { frame: frameNumber, timestampMs: loaded.timestampMs, width: loaded.width, height: loaded.height, source: "image", image: loaded.image };
        setImage(loaded.image); setSourceSize({ width: loaded.width, height: loaded.height });
        const registration = frameNumber > 0 && (frameNumber === 1 || frameNumber % 5 === 0) && referenceFrameRef.current ? engineRef.current.register(referenceFrameRef.current, frame, frameNumber) : undefined;
        processFrame(frame, registration);
        if (registration && !registration.accepted) addRisk({ code: "registration.rejected", severity: "warning", frame: frameNumber, message: registration.reason ?? "场景配准被拒绝", action: "select-anchors", recoverable: true });
        frameNumber += 1;
      }
      if (!isPreview) loaded.release?.();
      if (trackerRef.current?.paused) break;
    }
    runningRef.current = false; setRunning(false);
  };

  const selectFiles = async (selected: File[]) => {
    if (!selected.length) return;
    cameraSourceRef.current?.stop(); selectedFilePreviewRef.current?.release?.(); selectedFilePreviewRef.current = undefined; referenceFrameRef.current = undefined; trackerRef.current = undefined; templatesRef.current.clear(); previousSearchesRef.current.clear(); positionsRef.current.clear(); setCameraActive(false); setRunning(false); setFiles(selected); setPointState(createPointSetState()); releaseRefinementImage(); refinementTokenRef.current += 1; setDraft(undefined); setLegacyTracks([]); issuedIdsRef.current = [];
    try {
      const first = await loadFirstFileFrame(selected[0]); selectedFilePreviewRef.current = first; refinementImageRef.current = first.image; setImage(first.image); setReferenceImage(first.image); setSourceSize({ width: first.width, height: first.height }); setMode("annotate");
      void engineRef.current.load().then(reportEngineStatus);
    } catch (error) {
      setFiles([]); setImage(undefined); setReferenceImage(undefined); setSourceSize(undefined);
      addRisk({ code: selected[0].type.startsWith("video/") ? "video.decode-failed" : "image.decode-failed", severity: "error", frame: 0, message: error instanceof Error ? error.message : "文件解码失败", action: "select-file", recoverable: true });
    }
  };

  const openCamera = async (requestedFacingMode: CameraFacingMode = facingMode) => {
    const video = cameraVideoRef.current;
    if (!video) return;
    if (cameraSourceRef.current) { cameraTokenRef.current += 1; cameraSourceRef.current.stop(); cameraSourceRef.current = undefined; setCameraActive(false); setPointState(state => ({ ...state, cameraSession: { ...state.cameraSession, status: "stopped", recording: false } })); return; }
    referenceFrameRef.current = undefined; trackerRef.current = undefined; templatesRef.current.clear(); previousSearchesRef.current.clear(); positionsRef.current.clear(); releaseRefinementImage(); refinementTokenRef.current += 1; setDraft(undefined); setReferenceImage(undefined); setLegacyTracks([]); issuedIdsRef.current = []; setPointState(createPointSetState());
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
          if (!referenceFrameRef.current) { referenceFrameRef.current = frame; refinementImageRef.current = captured.image; setReferenceImage(captured.image); }
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
    let recorder: MediaRecorder;
    try { recorder = new MediaRecorder(stream, { mimeType }); }
    catch (error) { addRisk({ code: "recording.unsupported", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "无法创建录像编码器", action: "continue-local", recoverable: true }); return; }
    recordingChunksRef.current = [];
    recorder.ondataavailable = event => { if (event.data.size) recordingChunksRef.current.push(event.data); };
    recorder.onerror = () => addRisk({ code: "recording.unsupported", severity: "error", frame: frameRef.current, message: "录像编码器发生错误", action: "retry", recoverable: true });
    recorder.onstop = () => { const blob = new Blob(recordingChunksRef.current, { type: mimeType }); const durationMs = Math.max(0, performance.now() - recordingStartedAtRef.current); recorderRef.current = undefined; setRecordingActive(false); setPointState(state => ({ ...state, recording: { active: false, mimeType, blob, durationMs }, cameraSession: { ...state.cameraSession, recording: false } })); };
    recordingStartedAtRef.current = performance.now(); recorder.start(500); recorderRef.current = recorder; setRecordingActive(true); setPointState(state => ({ ...state, recording: { active: true, mimeType, blob: null, durationMs: null }, cameraSession: { ...state.cameraSession, recording: true } }));
  };

  const refineRecording = async () => {
    const blob = pointState.recording.blob;
    if (!blob || !seedsRef.current.length) return;
    const video = document.createElement("video"); const objectUrl = URL.createObjectURL(blob); video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = objectUrl;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("录制文件无法解码")); });
      const size = { width: video.videoWidth, height: video.videoHeight }; if (!size.width || !size.height) throw new Error("录制文件缺少原生尺寸");
      video.pause(); await seekVideoFrame(video, 0);
      const firstImage = await snapshotVideoFrame(video); let latestPreview = firstImage;
      setImage(firstImage); setSourceSize(size); setReferenceImage(firstImage); initializeTrackingFor(firstImage, size, "video");
      const frameTimes = videoFrameTimes(Number.isFinite(video.duration) ? video.duration : (pointState.recording.durationMs ?? 0) / 1000, 15);
      for (let index = 1; index < frameTimes.length && runningRef.current; index += 1) {
        const timestamp = frameTimes[index]; await seekVideoFrame(video, timestamp);
        const currentImage = await snapshotVideoFrame(video);
        if (latestPreview !== firstImage && latestPreview !== currentImage && "close" in latestPreview) (latestPreview as ImageBitmap).close();
        latestPreview = currentImage;
        const frame: BrowserFrame = { frame: index, timestampMs: timestamp * 1000, width: size.width, height: size.height, source: "video", image: currentImage };
        const registration = index % 5 === 0 && referenceFrameRef.current ? engineRef.current.register(referenceFrameRef.current, frame, index) : undefined;
        processFrame(frame, registration);
        if (registration && !registration.accepted) addRisk({ code: "registration.rejected", severity: "warning", frame: index, message: registration.reason ?? "Scene registration rejected", action: "select-anchors", recoverable: true });
        if (trackerRef.current?.paused) break;
      }
      setImage(latestPreview); setSourceSize(size);
    } catch (error) { addRisk({ code: "video.decode-failed", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "录制精算失败", action: "retry", recoverable: true }); }
    finally { video.removeAttribute("src"); video.load(); URL.revokeObjectURL(objectUrl); runningRef.current = false; setRunning(false); }
  };

  const beginFeatureDraft = (value: Roi, draftIntent: ExtractionIntent) => {
    if (!image || !sourceSize) return;
    const roi = normalizeNativeRoi(value, sourceSize);
    if (draft) {
      setDraft(current => current ? { ...current, roi, revision: nextRevision(), status: "refining", refinement: null } : current);
      return;
    }
    const id = `draft-${Date.now()}`;
    const token = ++refinementTokenRef.current;
    setDraft({ id, status: "selecting", intent: draftIntent, roi, revision: nextRevision(), refinement: null });
    void snapshotRefinementImage(image).then(snapshot => {
      if (token !== refinementTokenRef.current) {
        if (snapshot.owned && "close" in snapshot.image) (snapshot.image as ImageBitmap).close();
        return;
      }
      releaseRefinementImage();
      refinementImageRef.current = snapshot.image;
      refinementImageOwnedRef.current = snapshot.owned;
      setDraft(current => current?.id === id ? { ...current, status: "refining", revision: nextRevision() } : current);
    });
  };
  const onSelectionChange = (value: Roi) => beginFeatureDraft(value, intent);
  const confirmDraft = () => { if (!draft) return; const seed = confirmFeatureDraft(draft, nextPointId(issuedIdsRef.current)); if (!seed) return; issuedIdsRef.current = [...issuedIdsRef.current, seed.pointId]; setPointState(state => ({ ...state, seeds: [...state.seeds, seed], activePointIds: [...state.activePointIds, seed.pointId] })); refinementTokenRef.current += 1; releaseRefinementImage(); setDraft(undefined); setMode("annotate"); addEvent({ id: `initialized-${seed.pointId}`, frame: 0, kind: "initialized", message: `${seed.pointId} confirmed`, recoverable: false }); };
  const deleteDraft = () => { refinementTokenRef.current += 1; releaseRefinementImage(); setDraft(undefined); };
  const deleteSeed = (pointId: string) => setPointState(state => { const found = state.seeds.find(seed => seed.pointId === pointId); if (found) { setDeletedSeed(found); if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current); undoTimerRef.current = window.setTimeout(() => setDeletedSeed(undefined), 5000); } const tracksByPoint = new Map(state.tracksByPoint); tracksByPoint.delete(pointId); return { ...state, seeds: state.seeds.filter(seed => seed.pointId !== pointId), tracksByPoint, activePointIds: state.activePointIds.filter(id => id !== pointId) }; });
  const undoDelete = () => { if (!deletedSeed) return; setPointState(state => ({ ...state, seeds: [...state.seeds, deletedSeed].sort((a, b) => a.pointId.localeCompare(b.pointId)), activePointIds: [...state.activePointIds, deletedSeed.pointId].sort() })); setDeletedSeed(undefined); };
  const reinitialize = (pointId: string) => { const seed = pointState.seeds.find(item => item.pointId === pointId); if (!seed) return; deleteSeed(pointId); const nextIntent = modelIntent(seed.model); setIntent(nextIntent); beginFeatureDraft(seed.roi, nextIntent); };
  const toggleTracking = async () => { if (running) { runningRef.current = false; setRunning(false); return; } await engineRef.current.load(); if (!initializeTracking()) return; if (!cameraActive) await processFiles(files); };
  const defaultReportMetadata = (): ReportMetadata => {
    const base: ReportMetadata = { reportNumber: `R-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`, reportId: `report-${Date.now()}`, projectName: "", testId: "", operator: "", notes: "", sourceFile: files[0]?.name ?? (cameraActive ? "camera" : "input"), generatedAt: new Date().toISOString(), buildCommit: import.meta.env.VITE_COMMIT_SHA ?? "dev" };
    try { return { ...base, ...JSON.parse(localStorage.getItem("subpixel.report.metadata.v1") ?? "{}"), sourceFile: base.sourceFile, generatedAt: base.generatedAt, buildCommit: base.buildCommit }; } catch { return base; }
  };
  const snapshotReport = (metadata = reportModel?.metadata ?? defaultReportMetadata(), thresholds: QualityThresholds = reportModel?.thresholds ?? (() => { try { return { ...DEFAULT_QUALITY_THRESHOLDS, ...JSON.parse(localStorage.getItem("subpixel.report.thresholds.v1") ?? "{}") }; } catch { return DEFAULT_QUALITY_THRESHOLDS; } })()) => buildReportModel({ seeds: pointState.seeds, activePointIds: pointState.activePointIds, tracksByPoint: new Map([...pointState.tracksByPoint.entries()].map(([id, rows]) => [id, [...rows]])), registrations: [...pointState.registrations], recoveryEvents: [...pointState.recoveryEvents], riskNotices: [...pointState.riskNotices], processingStats: { ...pointState.processingStats }, events: [...events] }, metadata, thresholds);
  const openReport = () => { try { setReportModel(snapshotReport()); setReportOpen(true); } catch (error) { addRisk({ code: "export.failed", severity: "warning", frame: frameRef.current, message: error instanceof Error ? error.message : "报告阈值无效", action: "retry", recoverable: true }); } };
  const refreshReport = (metadata: ReportMetadata, thresholds: QualityThresholds) => { try { localStorage.setItem("subpixel.report.metadata.v1", JSON.stringify({ projectName: metadata.projectName, testId: metadata.testId, operator: metadata.operator, notes: metadata.notes })); localStorage.setItem("subpixel.report.thresholds.v1", JSON.stringify(thresholds)); } catch { /* local preferences are optional */ } setReportModel(snapshotReport({ ...metadata, generatedAt: new Date().toISOString() }, thresholds)); };
  const applyRecovery = (correspondences: AnchorCorrespondence[]) => { if (!trackerRef.current || correspondences.length < 4 || !sourceSize) return; const anchors = correspondences.map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: anchor.confidence >= .5 })); const quality = evaluateRecoveryAnchors(anchors, sourceSize); if (!quality.accepted) { addRisk({ code: "tracking.lost", severity: "error", frame: frameRef.current, message: quality.reason ?? "Recovery anchors rejected", action: "select-anchors", recoverable: true }); return; } trackerRef.current.applyAnchors(anchors); const event: RecoveryEvent = { id: `recovery-applied-${Date.now()}`, frame: frameRef.current, kind: "applied", anchorCount: anchors.length, coverage: quality.coverage, inlierRatio: 1, predictedMedianError: quality.predictedMedianError ?? 0, reversible: true, message: "recovery applied" }; setPointState(state => appendRecoveryEvent(state, event)); setRecoveryPaused(false); runningRef.current = true; setRunning(true); setMode("track"); };
  const rollbackRecovery = () => { setPointState(state => appendRecoveryEvent(state, { id: `recovery-rollback-${Date.now()}`, frame: frameRef.current, kind: "rolled-back", anchorCount: 0, coverage: 0, inlierRatio: 0, predictedMedianError: 0, reversible: false, message: "recovery rolled back" })); setRecoveryPaused(false); runningRef.current = true; setRunning(true); setMode("track"); };
  const exportResult = async (format: ExportFormat) => { try { await exportTracking(format, { roi: draft?.roi ?? pointState.seeds[0]?.roi ?? { x: 0, y: 0, width: 1, height: 1 }, model: intentToModel(intent), tracks: legacyTracks, multiTracks: flattenTracks(pointState), points: pointState.seeds, registrations: pointState.registrations, recoveryEvents: pointState.recoveryEvents, riskNotices: pointState.riskNotices, processingStats: pointState.processingStats, events, image, reportModel }); } catch (error) { addRisk({ code: "export.failed", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "Export failed", action: "export-current", recoverable: true }); } };

  const latestTracks = [...pointState.tracksByPoint.values()].map(items => items.at(-1)).filter((track): track is MultiPointTrack => Boolean(track));
  const cameraSession: CameraSession = pointState.cameraSession;
  return <div><video ref={cameraVideoRef} className="camera-video-source" muted playsInline aria-hidden="true" /><TrackingWorkbench image={image} referenceImage={referenceImage} currentImage={image} sourceSize={sourceSize} draft={draft} intent={intent} onIntentChange={setIntent} onSelectionChange={onSelectionChange} onConfirmDraft={confirmDraft} onDeleteDraft={deleteDraft} onDeleteSeed={deleteSeed} onReinitialize={reinitialize} onUndoDelete={undoDelete} canUndoDelete={Boolean(deletedSeed)} mode={mode} onModeChange={setMode} seeds={pointState.seeds} multiTracks={latestTracks} tracks={legacyTracks} events={events} running={running} onToggle={toggleTracking} onFiles={selectFiles} onExport={exportResult} onReview={frame => setLegacyTracks(current => current.map(track => track.frame === frame ? { ...track, state: "reviewed" } : track))} recoveryPaused={recoveryPaused} onApplyRecovery={applyRecovery} onRollbackRecovery={rollbackRecovery} onOpenCamera={() => void openCamera()} cameraActive={cameraActive} cameraSession={cameraSession} facingMode={facingMode} onSwitchCamera={() => { const next = facingMode === "environment" ? "user" : "environment"; setFacingMode(next); cameraSourceRef.current?.stop(); cameraSourceRef.current = undefined; if (cameraActive) window.setTimeout(() => void openCamera(next), 0); }} recordingActive={recordingActive} onToggleRecording={toggleRecording} recordingReady={Boolean(pointState.recording.blob)} onRefineRecording={() => void refineRecording()} riskNotices={pointState.riskNotices} processingStats={pointState.processingStats} report={reportModel} reportOpen={reportOpen} onOpenReport={openReport} onCloseReport={() => setReportOpen(false)} onRefreshReport={refreshReport} /></div>;
}
