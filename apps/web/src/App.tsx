import { useEffect, useRef, useState } from "react";
import { applyLocalAffine, createMultiPointTracker, evaluateRecoveryAnchors, type GrayPatch } from "@subpixel/algorithms";
import type { AnchorCorrespondence, CameraSession, EngineStatus, ExtractionIntent, FeatureDraft, FrameRegistration, MultiPointTrack, PointSeed, PointTrack, RecoveryEvent, RiskNotice, Roi, TrackingEvent, ReportMetadata, QualityThresholds, ReportModel, ReportOptions } from "@subpixel/contracts";
import { cameraSource, chooseRecordingMimeType, type CameraFacingMode } from "./features/capture/cameraSource";
import { loadFirstFileFrame, seekVideoFrame, snapshotVideoFrame, videoFrameTimes, type LoadedFileFrame } from "./features/capture/fileSource";
import { TrackingWorkbench } from "./features/tracking/TrackingWorkbench";
import { exportTracking, type ExportFormat, type ExportOptions, type ExportResult } from "./features/report/exportClient";
import { confirmFeatureDraft, intentToModel, nextPointId } from "./features/roi/pointState";
import { normalizeNativeRoi, type CanvasMode } from "./features/roi/RoiCanvas";
import { appendFrameLedgerEntry, appendRecoveryEvent, appendRegistration, appendRiskNotice, appendTracks, clearRiskNotices, clonePointSetState, createPointSetState, flattenTracks, recountFrameLedger, setTrackReviewDecision, summarizeProcessing, type PointSetState } from "./features/tracking/pointSetState";
import { extractNativePatch } from "./features/local/frameUtils";
import { LocalAlgorithmEngine, type BrowserFrame, type LocalSearchRegion } from "./features/local/localAlgorithmEngine";
import { LocalWorkerClient } from "./features/local/localWorkerClient";
import { refinementReasonMessage } from "./features/roi/refinementMessages";
import { buildReportModel, DEFAULT_QUALITY_THRESHOLDS } from "./features/report/reportModel";
import { captureRecoverySnapshot, restoreRecoverySnapshot, type RecoverySnapshot } from "./features/tracking/recoveryState";
import { composeRegistrationGuidance, reconcileRegistrationGuidance, type RegistrationGuidance } from "./features/local/localRegistration";
import { registrationRisk, trackingGateRisk } from "./features/local/riskNotice";
import { processCompleteOfflineSequence } from "./features/capture/offlineSequence";
import { moveReviewFrame, nextPendingPointId, tracksForFrame } from "./features/tracking/reviewState";
import { loadAlertSettings, normalizeAlertSettings, saveAlertSettings, shouldWarnForRegistration, shouldWarnForTrack, type AlertSettings } from "./features/tracking/alertSettings";

const defaultIntent: ExtractionIntent = "circle-center";

function modelIntent(model: PointSeed["model"]): ExtractionIntent {
  if (model === "circle") return "circle-center";
  if (model === "crosshair") return "crosshair-center";
  if (model === "diagonal") return "diagonal-center";
  if (model === "blob") return "blob-center";
  if (model === "speckle") return "speckle-center";
  return "natural-keypoint";
}

export function trackingTemplateRoi(seed: PointSeed, size: { width: number; height: number }, recoveredCenter?: { x: number; y: number }) {
  if (seed.model !== "natural-keypoint") {
    if (!recoveredCenter) return normalizeNativeRoi(seed.roi, size);
    return normalizeNativeRoi({ x: recoveredCenter.x - seed.roi.width / 2, y: recoveredCenter.y - seed.roi.height / 2, width: seed.roi.width, height: seed.roi.height }, size);
  }
  let patchSize = Math.max(9, Math.min(31, Math.floor(Math.min(seed.roi.width, seed.roi.height))));
  if (patchSize % 2 === 0) patchSize -= 1;
  const center = recoveredCenter ?? seed.snapped;
  return normalizeNativeRoi({ x: Math.round(center.x - (patchSize - 1) / 2), y: Math.round(center.y - (patchSize - 1) / 2), width: patchSize, height: patchSize }, size);
}

export function isCurrentRefinementRevision(responseRevision: number, currentRevision: number) {
  return responseRevision === currentRevision;
}

export function canStartTrackingInEngineMode(status: EngineStatus, degradedConfirmed: boolean) {
  const fullRegistration = status.opencv === "ready" && status.capabilities.registration && status.capabilities.descriptors;
  return fullRegistration || degradedConfirmed;
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
  const [recoveryUndoAvailable, setRecoveryUndoAvailable] = useState(false);
  const [deletedSeed, setDeletedSeed] = useState<PointSeed>();
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("environment");
  const [cameraActive, setCameraActive] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [reportModel, setReportModel] = useState<ReportModel>();
  const [reportOpen, setReportOpen] = useState(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({ opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } });
  const [degradedTrackingConfirmed, setDegradedTrackingConfirmed] = useState(false);
  const [reviewFrame, setReviewFrame] = useState(0);
  const [reviewPlaying, setReviewPlaying] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [selectedPointId, setSelectedPointId] = useState<string>();
  const [reinitializing, setReinitializing] = useState<{ pointId: string; frame: number }>();
  const [pendingReviewAdvance, setPendingReviewAdvance] = useState<{ pointId: string; frame: number }>();
  const [alertSettings, setAlertSettings] = useState<AlertSettings>(() => loadAlertSettings(typeof window === "undefined" ? undefined : window.localStorage));
  const alertSettingsRef = useRef(alertSettings);
  const seedsRef = useRef<PointSeed[]>([]);
  const trackerRef = useRef<ReturnType<typeof createMultiPointTracker>>();
  const templatesRef = useRef(new Map<string, GrayPatch>());
  const initialTemplatesRef = useRef(new Map<string, GrayPatch>());
  const previousSearchesRef = useRef(new Map<string, LocalSearchRegion>());
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const referencePositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const frameRef = useRef(0);
  const runningRef = useRef(false);
  const engineRef = useRef(new LocalAlgorithmEngine());
  const localWorkerRef = useRef<LocalWorkerClient>();
  const referenceFrameRef = useRef<BrowserFrame>();
  const keyframeFrameRef = useRef<BrowserFrame>();
  const previousTrackingFrameRef = useRef<BrowserFrame>();
  const adjacentChainRef = useRef<RegistrationGuidance>();
  const recoverySnapshotRef = useRef<RecoverySnapshot>();
  const recoveryPointStateSnapshotRef = useRef<PointSetState>();
  const recoveryKeyframeFrameSnapshotRef = useRef<BrowserFrame>();
  const refinementImageRef = useRef<CanvasImageSource>();
  const refinementImageOwnedRef = useRef(false);
  const refinementTokenRef = useRef(0);
  const revisionRef = useRef(0);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const selectedFilePreviewRef = useRef<LoadedFileFrame>();
  const cameraSourceRef = useRef<Awaited<ReturnType<typeof cameraSource>>>();
  const cameraTokenRef = useRef(0);
  const cameraPreviewFrozenRef = useRef(false);
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
  const reviewTokenRef = useRef(0);

  useEffect(() => { seedsRef.current = pointState.seeds; }, [pointState.seeds]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => { alertSettingsRef.current = alertSettings; }, [alertSettings]);
  useEffect(() => {
    if (!pendingReviewAdvance) return;
    setSelectedPointId(nextPendingPointId(pointState.seeds, flattenTracks(pointState), pendingReviewAdvance.frame, pendingReviewAdvance.pointId) ?? pendingReviewAdvance.pointId);
    setPendingReviewAdvance(undefined);
  }, [pointState, pendingReviewAdvance]);
  useEffect(() => { localWorkerRef.current = new LocalWorkerClient(); return () => localWorkerRef.current?.dispose(); }, []);
  useEffect(() => () => { cameraTokenRef.current += 1; cameraSourceRef.current?.stop(); selectedFilePreviewRef.current?.release?.(); recorderRef.current?.stop(); releaseRefinementImage(); if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current); const previous = displayedImageRef.current; if (previous && "close" in previous) (previous as ImageBitmap).close(); }, []);
  useEffect(() => { if (image && image !== displayedImageRef.current) { const previous = displayedImageRef.current; displayedImageRef.current = image; const initialImage = referenceFrameRef.current?.image; const keyframeImage = keyframeFrameRef.current?.image; const adjacentImage = previousTrackingFrameRef.current?.image; const rollbackImage = recoveryKeyframeFrameSnapshotRef.current?.image; if (previous && previous !== initialImage && previous !== keyframeImage && previous !== adjacentImage && previous !== rollbackImage && "close" in previous) (previous as ImageBitmap).close(); } }, [image]);
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
    setEngineStatus(status);
    if (status.opencv === "unavailable") addRisk({ code: "opencv.load-failed", severity: "warning", frame: frameRef.current, message: "OpenCV.js 加载失败，将使用 TypeScript 小位移路径", action: "continue-local", recoverable: true });
    else if (!status.capabilities.registration || !status.capabilities.descriptors) addRisk({ code: "opencv.feature-unavailable", severity: "warning", frame: frameRef.current, message: "当前 OpenCV.js 构建缺少 SIFT/ORB 或单应配准能力", action: "continue-local", recoverable: true });
    else setPointState(state => clearRiskNotices(state, notice => notice.code === "opencv.load-failed" || notice.code === "opencv.feature-unavailable"));
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

  const processFrame = (
    frame: BrowserFrame,
    directRegistration?: FrameRegistration,
    input: { runMode?: "offline" | "live"; inputIndex?: number; sourceName?: string } = {}
  ) => {
    const startedAt = performance.now();
    frameRef.current = frame.frame;
    const tracker = trackerRef.current;
    if (!tracker) return;
    const previousFrame = previousTrackingFrameRef.current;
    let adjacent: RegistrationGuidance | undefined;
    if (previousFrame && previousFrame.frame < frame.frame) adjacent = engineRef.current.registerAdjacent(previousFrame, frame);
    if (adjacent) adjacentChainRef.current = composeRegistrationGuidance(adjacentChainRef.current, adjacent) ?? adjacent;
    let registration: RegistrationGuidance | undefined = adjacentChainRef.current;
    if (directRegistration) {
      registration = reconcileRegistrationGuidance(directRegistration, adjacentChainRef.current, { width: frame.width, height: frame.height });
      if (registration.usableForPrediction ?? registration.accepted) adjacentChainRef.current = registration;
    }
    const runMode = input.runMode ?? (frame.source === "camera" ? "live" : "offline");
    const result = engineRef.current.track(frame, seedsRef.current, { templates: templatesRef.current, positions: positionsRef.current, previousSearches: previousSearchesRef.current, referencePositions: referencePositionsRef.current, registration, runMode, tracker });
    result.tracks.filter(track => shouldWarnForTrack(track, alertSettingsRef.current)).forEach(track => {
      const risk = trackingGateRisk(track.pointId, track.gateFailures);
      addRisk({ ...risk, severity: track.state === "lost" ? "error" : risk.severity, frame: frame.frame, pointId: track.pointId });
    });
    if (registration && (registration.decision === "rejected" || registration.accepted === false) && shouldWarnForRegistration(registration, alertSettingsRef.current)) addRisk({ ...registrationRisk(registration.reason), frame: frame.frame });
    result.tracks.filter(track => track.state === "valid" || track.state === "provisional").forEach(track => positionsRef.current.set(track.pointId, track.refined));
    const validCount = result.tracks.filter(track => track.state === "valid").length;
    const provisionalCount = result.tracks.filter(track => track.state === "provisional").length;
    const suspectCount = result.tracks.filter(track => track.state === "suspect").length;
    const missingCount = result.tracks.filter(track => track.state === "lost" || track.state === "paused").length;
    const decision = registration?.decision ?? (registration?.accepted === true ? "accepted" : registration?.accepted === false ? "rejected" : null);
    const topologyStable = result.tracks.every(track => track.topologyErrorPx === null || track.topologyErrorPx === undefined || track.topologyErrorPx <= 3);
    const updateKeyframe = decision === "accepted" && validCount / Math.max(1, result.tracks.length) >= .8 && topologyStable;
    setPointState(state => {
      let next = registration ? appendRegistration(appendTracks(state, result.tracks), registration) : appendTracks(state, result.tracks);
      next = appendFrameLedgerEntry(next, {
        inputIndex: input.inputIndex ?? frame.frame,
        frame: frame.frame,
        sourceName: input.sourceName ?? `${frame.source}-frame-${frame.frame}`,
        timestampMs: frame.timestampMs,
        decodeStatus: "decoded",
        processingStatus: decision === "rejected" && registration?.failureClass === "hard-geometry" ? "isolated" : "processed",
        validCount,
        provisionalCount,
        suspectCount,
        missingCount,
        keyframe: updateKeyframe || frame.frame === 0,
        registrationDecision: decision,
        failureReason: registration?.reason ?? null
      });
      return next;
    });
    setLegacyTracks(current => [...current, ...result.tracks.map(track => ({ frame: track.frame, timestampMs: track.timestampMs, x: track.refined.x, y: track.refined.y, model: track.model, residual: track.residual, confidence: track.confidence, state: track.state === "provisional" ? "reviewed" : track.state === "paused" ? "suspect" : track.state, durationMs: 1 }))]);
    const latency = performance.now() - startedAt;
    latencyRef.current = [...latencyRef.current.slice(-59), latency];
    processedFrameCountRef.current += 1;
    const processingStats = summarizeProcessing({ processedFrames: processedFrameCountRef.current, droppedFrames: droppedFrameCountRef.current, latencies: latencyRef.current, nativeWidth: frame.width, nativeHeight: frame.height, engine: engineRef.current.engineStatus.opencv === "ready" ? "opencv-js" : "typescript" });
    setPointState(state => ({ ...state, processingStats }));
    if (processingStats.p95LatencyMs > 1000 / 15) addRisk({ code: "tracking.frame-budget", severity: "warning", frame: frame.frame, message: `处理 P95 ${processingStats.p95LatencyMs.toFixed(1)} ms，已跳帧保持原始分辨率`, action: "pause", recoverable: true });
    if (result.paused && runMode === "live") {
      const pauseMessage = decision === "rejected"
        ? `场景配准硬失败：${registration?.reason ?? "几何门控未通过"}`
        : `可疑与失锁比例 ${(result.invalidRatio * 100).toFixed(0)}%，跟踪已暂停`;
      runningRef.current = false; setRunning(false); setMode("recover"); setRecoveryPaused(true);
      addRisk({ code: "tracking.lost", severity: "error", frame: frame.frame, message: pauseMessage, action: "select-anchors", recoverable: true });
      addRisk({ code: "tracking.manual-anchors-required", severity: "error", frame: frame.frame, message: "需要重新选择 4-6 个空间分散的对应锚点", action: "select-anchors", recoverable: true });
      addEvent({ id: `lost-${frame.frame}`, frame: frame.frame, kind: "lost", message: `${pauseMessage}；请选择恢复锚点`, recoverable: true });
    }
    if (updateKeyframe) {
      keyframeFrameRef.current = frame;
      referencePositionsRef.current = new Map(result.tracks.filter(track => track.state === "valid").map(track => [track.pointId, { ...track.refined }]));
      templatesRef.current = new Map(seedsRef.current.map(seed => {
        const current = result.tracks.find(track => track.pointId === seed.pointId && track.state === "valid");
        const template = current
          ? extractNativePatch(frame.image, trackingTemplateRoi(seed, { width: frame.width, height: frame.height }, current.refined))
          : templatesRef.current.get(seed.pointId)!;
        return [seed.pointId, template];
      }));
      adjacentChainRef.current = undefined;
    }
    const hardFailure = decision === "rejected" && registration?.failureClass === "hard-geometry";
    if (!hardFailure && (validCount + provisionalCount) / Math.max(1, result.tracks.length) >= .8) previousTrackingFrameRef.current = frame;
    const oldImage = previousFrame?.image;
    if (oldImage && oldImage !== displayedImageRef.current && oldImage !== referenceFrameRef.current?.image && oldImage !== keyframeFrameRef.current?.image && oldImage !== recoveryKeyframeFrameSnapshotRef.current?.image && "close" in oldImage) (oldImage as ImageBitmap).close();
    return result;
  };

  const initializeTrackingFor = (baseImage: CanvasImageSource, size: { width: number; height: number }, source: BrowserFrame["source"]) => {
    if (!seedsRef.current.length) return false;
    trackerRef.current = createMultiPointTracker(seedsRef.current, { pauseLostRatio: alertSettingsRef.current.pauseInvalidRatio }); trackerRef.current.initialize();
    templatesRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, extractNativePatch(baseImage, trackingTemplateRoi(seed, size))]));
    initialTemplatesRef.current = new Map(templatesRef.current);
    previousSearchesRef.current = new Map(seedsRef.current.map(seed => {
      const template = templatesRef.current.get(seed.pointId)!;
      const radius = seed.model === "natural-keypoint" ? Math.min(192, Math.max(24, Math.max(template.width, template.height) * 1.5)) : Math.max(10, Math.min(96, Math.max(template.width, template.height) * .5));
      const searchRoi = normalizeNativeRoi({ x: seed.snapped.x - template.width / 2 - radius, y: seed.snapped.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 }, size);
      return [seed.pointId, { patch: extractNativePatch(baseImage, searchRoi), roi: searchRoi }];
    }));
    positionsRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, seed.snapped]));
    referencePositionsRef.current = new Map(seedsRef.current.map(seed => [seed.pointId, { ...seed.snapped }]));
    referenceFrameRef.current = { frame: 0, timestampMs: 0, width: size.width, height: size.height, source, image: baseImage };
    keyframeFrameRef.current = referenceFrameRef.current;
    previousTrackingFrameRef.current = referenceFrameRef.current;
    adjacentChainRef.current = undefined;
    recoverySnapshotRef.current = undefined; recoveryPointStateSnapshotRef.current = undefined; recoveryKeyframeFrameSnapshotRef.current = undefined; setRecoveryUndoAvailable(false);
    frameRef.current = 0; processedFrameCountRef.current = 0; droppedFrameCountRef.current = 0; latencyRef.current = [];
    runningRef.current = true; setLegacyTracks([]);
    setPointState(state => ({ ...state, tracksByPoint: new Map(), registrations: [], frameLedger: [] }));
    setMode("track"); setRunning(true); return true;
  };

  const initializeTracking = () => image && sourceSize ? initializeTrackingFor(image, sourceSize, cameraActive ? "camera" : files[0]?.type.startsWith("video/") ? "video" : "image") : false;

  const processFiles = async (selected: File[]) => {
    let frameNumber = 0;
    for (let fileIndex = 0; fileIndex < selected.length && runningRef.current; fileIndex += 1) {
      const isPreview = fileIndex === 0 && Boolean(selectedFilePreviewRef.current);
      let loaded: LoadedFileFrame;
      try {
        loaded = isPreview ? selectedFilePreviewRef.current! : await loadFirstFileFrame(selected[fileIndex]);
      } catch (error) {
        setPointState(state => appendFrameLedgerEntry(state, {
          inputIndex: fileIndex,
          frame: null,
          sourceName: selected[fileIndex].name,
          timestampMs: null,
          decodeStatus: "failed",
          processingStatus: "isolated",
          validCount: 0,
          provisionalCount: 0,
          suspectCount: 0,
          missingCount: seedsRef.current.length,
          keyframe: false,
          registrationDecision: "rejected",
          failureReason: error instanceof Error ? error.message : "image.decode-failed"
        }));
        addRisk({ code: "image.decode-failed", severity: "error", frame: frameNumber, message: `${selected[fileIndex].name} 解码失败，已隔离并继续后续输入`, action: "select-file", recoverable: true });
        continue;
      }
      if (loaded.video) {
        let latestPreview: CanvasImageSource = loaded.image;
        const firstFrameNumber = frameNumber;
        const frameTimes = videoFrameTimes(loaded.durationMs ? loaded.durationMs / 1000 : loaded.video.duration, 15);
        const attempted = await processCompleteOfflineSequence(frameTimes, async (timeSeconds, index) => {
          const currentFrameNumber = firstFrameNumber + index;
          const currentImage = timeSeconds === 0 ? loaded.image : (await seekVideoFrame(loaded.video!, timeSeconds), await snapshotVideoFrame(loaded.video!));
          latestPreview = currentImage;
          const frame: BrowserFrame = { frame: currentFrameNumber, timestampMs: timeSeconds * 1000, width: loaded.width, height: loaded.height, source: "video", image: currentImage };
          const registration = currentFrameNumber > 0 && (currentFrameNumber === 1 || currentFrameNumber % 5 === 0) && keyframeFrameRef.current ? engineRef.current.register(keyframeFrameRef.current, frame, currentFrameNumber) : undefined;
          processFrame(frame, registration, { runMode: "offline", inputIndex: currentFrameNumber, sourceName: `${selected[fileIndex].name}@${timeSeconds.toFixed(3)}s` });
        }, (timeSeconds, index, error) => {
          const currentFrameNumber = firstFrameNumber + index;
          setPointState(state => appendFrameLedgerEntry(state, {
            inputIndex: currentFrameNumber, frame: currentFrameNumber, sourceName: `${selected[fileIndex].name}@${timeSeconds.toFixed(3)}s`, timestampMs: timeSeconds * 1000,
            decodeStatus: "failed", processingStatus: "isolated", validCount: 0, provisionalCount: 0, suspectCount: 0,
            missingCount: seedsRef.current.length, keyframe: false, registrationDecision: "rejected",
            failureReason: error instanceof Error ? error.message : "video.frame-decode-failed"
          }));
          addRisk({ code: "video.decode-failed", severity: "error", frame: currentFrameNumber, message: `视频帧 ${currentFrameNumber + 1} 解码失败，已隔离并继续`, action: "retry", recoverable: true });
        }, () => runningRef.current);
        frameNumber += attempted;
        setImage(latestPreview); setSourceSize({ width: loaded.width, height: loaded.height });
      } else {
        const frame: BrowserFrame = { frame: frameNumber, timestampMs: loaded.timestampMs, width: loaded.width, height: loaded.height, source: "image", image: loaded.image };
        setImage(loaded.image); setSourceSize({ width: loaded.width, height: loaded.height });
        const registration = frameNumber > 0 && (frameNumber === 1 || frameNumber % 5 === 0) && keyframeFrameRef.current ? engineRef.current.register(keyframeFrameRef.current, frame, frameNumber) : undefined;
        processFrame(frame, registration, { runMode: "offline", inputIndex: fileIndex, sourceName: selected[fileIndex].name });
        frameNumber += 1;
      }
      if (!isPreview) loaded.release?.();
    }
    runningRef.current = false; setRunning(false);
    if (frameNumber > 0) {
      const lastFrame = frameNumber - 1;
      setReviewFrame(lastFrame);
      setSelectedPointId(seedsRef.current[0]?.pointId);
      setMode("review");
    }
  };

  const selectReviewFrame = async (frame: number) => {
    const entry = pointState.frameLedger.find(item => item.frame === frame);
    if (!entry || entry.frame === null) return;
    const token = ++reviewTokenRef.current;
    setReviewPlaying(false);
    setReviewLoading(true);
    try {
      let nextImage: CanvasImageSource;
      let width: number;
      let height: number;
      const preview = selectedFilePreviewRef.current;
      if (files.length === 1 && preview?.video) {
        await seekVideoFrame(preview.video, (entry.timestampMs ?? 0) / 1000);
        nextImage = await snapshotVideoFrame(preview.video);
        width = preview.width;
        height = preview.height;
      } else {
        const file = files[entry.inputIndex];
        if (!file) throw new Error("找不到该帧对应的原始文件");
        const loaded = await loadFirstFileFrame(file);
        if (loaded.video) {
          await seekVideoFrame(loaded.video, (entry.timestampMs ?? 0) / 1000);
          nextImage = await snapshotVideoFrame(loaded.video);
          loaded.release?.();
        } else nextImage = loaded.image;
        width = loaded.width;
        height = loaded.height;
      }
      if (token !== reviewTokenRef.current) {
        if ("close" in nextImage) (nextImage as ImageBitmap).close();
        return;
      }
      setImage(nextImage);
      setSourceSize({ width, height });
      setReviewFrame(frame);
      frameRef.current = frame;
    } catch (error) {
      addRisk({ code: "image.decode-failed", severity: "error", frame, message: error instanceof Error ? error.message : "复核帧解码失败", action: "retry", recoverable: true });
    } finally {
      if (token === reviewTokenRef.current) setReviewLoading(false);
    }
  };

  useEffect(() => {
    if (!reviewPlaying || reviewLoading || mode !== "review") return;
    const next = moveReviewFrame(pointState.frameLedger, reviewFrame, 1);
    if (next === reviewFrame) { setReviewPlaying(false); return; }
    const timer = window.setTimeout(() => void selectReviewFrame(next).then(() => setReviewPlaying(true)), 650);
    return () => window.clearTimeout(timer);
  }, [mode, pointState.frameLedger, reviewFrame, reviewLoading, reviewPlaying]);

  const selectFiles = async (selected: File[]) => {
    if (!selected.length) return;
    cameraSourceRef.current?.stop(); selectedFilePreviewRef.current?.release?.(); selectedFilePreviewRef.current = undefined; referenceFrameRef.current = undefined; keyframeFrameRef.current = undefined; previousTrackingFrameRef.current = undefined; adjacentChainRef.current = undefined; trackerRef.current = undefined; templatesRef.current.clear(); initialTemplatesRef.current.clear(); previousSearchesRef.current.clear(); positionsRef.current.clear(); referencePositionsRef.current.clear(); recoverySnapshotRef.current = undefined; recoveryPointStateSnapshotRef.current = undefined; recoveryKeyframeFrameSnapshotRef.current = undefined; setRecoveryUndoAvailable(false); setCameraActive(false); setRunning(false); setFiles(selected); setPointState(createPointSetState()); setDegradedTrackingConfirmed(false); releaseRefinementImage(); refinementTokenRef.current += 1; reviewTokenRef.current += 1; setDraft(undefined); setLegacyTracks([]); setReviewFrame(0); setReviewPlaying(false); setSelectedPointId(undefined); setReinitializing(undefined); issuedIdsRef.current = [];
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
    if (cameraSourceRef.current) { cameraTokenRef.current += 1; cameraSourceRef.current.stop(); cameraSourceRef.current = undefined; cameraPreviewFrozenRef.current = false; setCameraActive(false); setPointState(state => ({ ...state, cameraSession: { ...state.cameraSession, status: "stopped", recording: false } })); return; }
    referenceFrameRef.current = undefined; keyframeFrameRef.current = undefined; previousTrackingFrameRef.current = undefined; adjacentChainRef.current = undefined; trackerRef.current = undefined; templatesRef.current.clear(); initialTemplatesRef.current.clear(); previousSearchesRef.current.clear(); positionsRef.current.clear(); referencePositionsRef.current.clear(); recoverySnapshotRef.current = undefined; recoveryPointStateSnapshotRef.current = undefined; recoveryKeyframeFrameSnapshotRef.current = undefined; setRecoveryUndoAvailable(false); setDegradedTrackingConfirmed(false); releaseRefinementImage(); refinementTokenRef.current += 1; cameraPreviewFrozenRef.current = false; setDraft(undefined); setReferenceImage(undefined); setLegacyTracks([]); setFiles([]); setReviewFrame(0); setReviewPlaying(false); setSelectedPointId(undefined); setReinitializing(undefined); setMode("annotate"); issuedIdsRef.current = []; setPointState(createPointSetState());
    setPointState(state => ({ ...state, cameraSession: { ...state.cameraSession, status: "requesting", facingMode: requestedFacingMode, error: null } }));
    void engineRef.current.load().then(reportEngineStatus);
    try {
      const source = await cameraSource(video, requestedFacingMode); cameraSourceRef.current = source; setCameraActive(true); const token = ++cameraTokenRef.current;
      setPointState(state => ({ ...state, cameraSession: { status: "ready", facingMode: requestedFacingMode, nativeWidth: video.videoWidth, nativeHeight: video.videoHeight, recording: false, error: null }, processingStats: { ...state.processingStats, nativeWidth: video.videoWidth, nativeHeight: video.videoHeight } }));
      void (async () => {
        for await (const captured of source) {
          if (token !== cameraTokenRef.current) break;
          if (cameraPreviewFrozenRef.current) {
            if ("close" in captured.image) (captured.image as ImageBitmap).close();
            continue;
          }
          const frame: BrowserFrame = { frame: frameRef.current + 1, timestampMs: captured.timestampMs, width: captured.width, height: captured.height, source: "camera", image: captured.image };
          setImage(captured.image); setSourceSize({ width: captured.width, height: captured.height });
          if (!referenceFrameRef.current) { referenceFrameRef.current = frame; refinementImageRef.current = captured.image; setReferenceImage(captured.image); }
          if (runningRef.current && trackerRef.current) {
            if (captured.timestampMs - lastProcessedAtRef.current < 1000 / 15) { droppedFrameCountRef.current += 1; continue; }
            lastProcessedAtRef.current = captured.timestampMs;
            const registration = (frame.frame === 1 || frame.frame % 5 === 0) && keyframeFrameRef.current ? engineRef.current.register(keyframeFrameRef.current, frame, frame.frame) : undefined;
            processFrame(frame, registration, { runMode: "live", inputIndex: frame.frame, sourceName: "camera" });
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
    cameraPreviewFrozenRef.current = true;
    let completed = false;
    const video = document.createElement("video"); const objectUrl = URL.createObjectURL(blob); video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = objectUrl;
    try {
      await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("录制文件无法解码")); });
      const size = { width: video.videoWidth, height: video.videoHeight }; if (!size.width || !size.height) throw new Error("录制文件缺少原生尺寸");
      video.pause(); await seekVideoFrame(video, 0);
      const firstImage = await snapshotVideoFrame(video); let latestPreview = firstImage;
      setImage(firstImage); setSourceSize(size); setReferenceImage(firstImage); initializeTrackingFor(firstImage, size, "video");
      const frameTimes = videoFrameTimes(Number.isFinite(video.duration) ? video.duration : (pointState.recording.durationMs ?? 0) / 1000, 15);
      processFrame({ frame: 0, timestampMs: 0, width: size.width, height: size.height, source: "video", image: firstImage }, undefined, { runMode: "offline", inputIndex: 0, sourceName: "recording@0.000s" });
      await processCompleteOfflineSequence(frameTimes.slice(1), async (timestamp, offset) => {
        const index = offset + 1;
        await seekVideoFrame(video, timestamp);
        const currentImage = await snapshotVideoFrame(video);
        latestPreview = currentImage;
        const frame: BrowserFrame = { frame: index, timestampMs: timestamp * 1000, width: size.width, height: size.height, source: "video", image: currentImage };
        const registration = (index === 1 || index % 5 === 0) && keyframeFrameRef.current ? engineRef.current.register(keyframeFrameRef.current, frame, index) : undefined;
        processFrame(frame, registration, { runMode: "offline", inputIndex: index, sourceName: `recording@${timestamp.toFixed(3)}s` });
      }, (timestamp, offset, error) => {
        const index = offset + 1;
        setPointState(state => appendFrameLedgerEntry(state, {
          inputIndex: index, frame: index, sourceName: `recording@${timestamp.toFixed(3)}s`, timestampMs: timestamp * 1000,
          decodeStatus: "failed", processingStatus: "isolated", validCount: 0, provisionalCount: 0, suspectCount: 0,
          missingCount: seedsRef.current.length, keyframe: false, registrationDecision: "rejected",
          failureReason: error instanceof Error ? error.message : "video.frame-decode-failed"
        }));
        addRisk({ code: "video.decode-failed", severity: "error", frame: index, message: `录制帧 ${index + 1} 解码失败，已隔离并继续精算`, action: "retry", recoverable: true });
      }, () => runningRef.current);
      setImage(latestPreview); setSourceSize(size);
      const lastFrame = Math.max(0, frameTimes.length - 1);
      setReviewFrame(lastFrame); setSelectedPointId(seedsRef.current[0]?.pointId); setMode("review");
      completed = true;
    } catch (error) { addRisk({ code: "video.decode-failed", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "录制精算失败", action: "retry", recoverable: true }); }
    finally { if (!completed) cameraPreviewFrozenRef.current = false; video.removeAttribute("src"); video.load(); URL.revokeObjectURL(objectUrl); runningRef.current = false; setRunning(false); }
  };

  const beginFeatureDraft = (value: Roi, draftIntent: ExtractionIntent) => {
    if (!image || !sourceSize) return;
    if (cameraActive) cameraPreviewFrozenRef.current = true;
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
  const confirmDraft = () => {
    if (!draft) return;
    if (reinitializing) {
      const existingSeed = pointState.seeds.find(item => item.pointId === reinitializing.pointId);
      const refinedSeed = confirmFeatureDraft(draft, reinitializing.pointId);
      if (!existingSeed || !refinedSeed || !draft.refinement?.point) return;
      const point = draft.refinement.point;
      setPointState(state => {
        if (!state.frameLedger.length) return { ...state, seeds: state.seeds.map(seed => seed.pointId === refinedSeed.pointId ? refinedSeed : seed) };
        const current = state.tracksByPoint.get(refinedSeed.pointId)?.find(track => track.frame === reinitializing.frame);
        const manualTrack: MultiPointTrack = {
          pointId: refinedSeed.pointId, frame: reinitializing.frame, timestampMs: current?.timestampMs ?? 0,
          predicted: current?.predicted ?? point, refined: point, model: existingSeed.model,
          confidence: draft.refinement!.confidence, residual: draft.refinement!.residualPx ?? 0,
          geometry: draft.refinement!.geometry ?? null, flowErrorForwardBackward: null, ncc: current?.ncc ?? null,
          descriptorDistance: null, epipolarError: null, predictionSource: "manual-recovery",
          innovationPx: current ? Math.hypot(point.x - current.predicted.x, point.y - current.predicted.y) : 0,
          localAffineResidualPx: null, gateFailures: [], candidateUniqueness: draft.refinement!.geometry?.kind === "corner" ? draft.refinement!.geometry.uniquenessRatio : null,
          registrationDecision: current?.registrationDecision, pointGatePassed: true, topologyErrorPx: null,
          missingReason: null, state: "reviewed", relocationMethod: "manual"
        };
        const withTrack = appendTracks(state, [manualTrack]);
        const withoutResolvedPointRisks = clearRiskNotices(withTrack, notice => notice.pointId === refinedSeed.pointId && notice.frame === reinitializing.frame);
        return recountFrameLedger(withoutResolvedPointRisks, reinitializing.frame);
      });
      positionsRef.current.set(refinedSeed.pointId, point);
      if (image && sourceSize) {
        const templateRoi = trackingTemplateRoi(existingSeed, sourceSize, point);
        templatesRef.current.set(refinedSeed.pointId, extractNativePatch(image, templateRoi));
      }
      addEvent({ id: `manual-review-${refinedSeed.pointId}-${reinitializing.frame}-${Date.now()}`, frame: reinitializing.frame, kind: "reviewed", message: `${refinedSeed.pointId} 已通过手动 ROI 重新亚像素定位`, recoverable: true });
      setSelectedPointId(refinedSeed.pointId);
      if (pointState.frameLedger.length) setPendingReviewAdvance({ pointId: refinedSeed.pointId, frame: reinitializing.frame });
      setReinitializing(undefined);
      refinementTokenRef.current += 1; releaseRefinementImage(); cameraPreviewFrozenRef.current = false; setDraft(undefined);
      setMode(pointState.frameLedger.length ? "review" : "annotate");
      return;
    }
    const seed = confirmFeatureDraft(draft, nextPointId(issuedIdsRef.current));
    if (!seed) return;
    issuedIdsRef.current = [...issuedIdsRef.current, seed.pointId];
    setPointState(state => ({ ...state, seeds: [...state.seeds, seed], activePointIds: [...state.activePointIds, seed.pointId] }));
    setSelectedPointId(seed.pointId);
    refinementTokenRef.current += 1; releaseRefinementImage(); cameraPreviewFrozenRef.current = false; setDraft(undefined); setMode("annotate");
    addEvent({ id: `initialized-${seed.pointId}`, frame: 0, kind: "initialized", message: `${seed.pointId} confirmed`, recoverable: false });
  };
  const deleteDraft = () => { refinementTokenRef.current += 1; releaseRefinementImage(); cameraPreviewFrozenRef.current = false; setDraft(undefined); setReinitializing(undefined); };
  const deleteSeed = (pointId: string) => setPointState(state => { const found = state.seeds.find(seed => seed.pointId === pointId); if (found) { setDeletedSeed(found); if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current); undoTimerRef.current = window.setTimeout(() => setDeletedSeed(undefined), 5000); } const tracksByPoint = new Map(state.tracksByPoint); tracksByPoint.delete(pointId); return { ...state, seeds: state.seeds.filter(seed => seed.pointId !== pointId), tracksByPoint, activePointIds: state.activePointIds.filter(id => id !== pointId) }; });
  const undoDelete = () => { if (!deletedSeed) return; setPointState(state => ({ ...state, seeds: [...state.seeds, deletedSeed].sort((a, b) => a.pointId.localeCompare(b.pointId)), activePointIds: [...state.activePointIds, deletedSeed.pointId].sort() })); setDeletedSeed(undefined); };
  const reinitialize = (pointId: string) => {
    const seed = pointState.seeds.find(item => item.pointId === pointId);
    if (!seed || !sourceSize) return;
    const frame = mode === "review" ? reviewFrame : 0;
    const current = pointState.tracksByPoint.get(pointId)?.find(track => track.frame === frame);
    const center = current?.refined ?? seed.snapped;
    const roi = normalizeNativeRoi({ x: center.x - seed.roi.width / 2, y: center.y - seed.roi.height / 2, width: seed.roi.width, height: seed.roi.height }, sourceSize);
    const nextIntent = modelIntent(seed.model);
    setSelectedPointId(pointId); setReinitializing({ pointId, frame }); setIntent(nextIntent);
    beginFeatureDraft(roi, nextIntent);
  };
  const toggleTracking = async () => {
    if (running) { runningRef.current = false; setRunning(false); return; }
    const status = await engineRef.current.load(); reportEngineStatus(status);
    if (!canStartTrackingInEngineMode(status, degradedTrackingConfirmed)) {
      addRisk({ code: status.opencv === "unavailable" ? "opencv.load-failed" : "opencv.feature-unavailable", severity: "warning", frame: frameRef.current, message: "高精度配准不可用。确认后仅允许小位移 NCC 跟踪；检测到大运动会立即暂停", action: "continue-local", recoverable: true });
      return;
    }
    if (!initializeTracking()) return;
    if (!cameraActive) await processFiles(files);
  };
  const defaultReportMetadata = (): ReportMetadata => {
    const base: ReportMetadata = { reportNumber: `R-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`, reportId: `report-${Date.now()}`, projectName: "", testId: "", operator: "", notes: "", sourceFile: files[0]?.name ?? (cameraActive ? "camera" : "input"), generatedAt: new Date().toISOString(), buildCommit: import.meta.env.VITE_COMMIT_SHA ?? "dev" };
    try { return { ...base, ...JSON.parse(localStorage.getItem("subpixel.report.metadata.v1") ?? "{}"), sourceFile: base.sourceFile, generatedAt: base.generatedAt, buildCommit: base.buildCommit }; } catch { return base; }
  };
  const defaultReportOptions = (): Partial<ReportOptions> => { try { return JSON.parse(localStorage.getItem("subpixel.report.options.v1") ?? "{}"); } catch { return {}; } };
  const snapshotReport = (metadata = reportModel?.metadata ?? defaultReportMetadata(), thresholds: QualityThresholds = reportModel?.thresholds ?? (() => { try { return { ...DEFAULT_QUALITY_THRESHOLDS, ...JSON.parse(localStorage.getItem("subpixel.report.thresholds.v1") ?? "{}") }; } catch { return DEFAULT_QUALITY_THRESHOLDS; } })(), options: Partial<ReportOptions> = reportModel?.options ?? defaultReportOptions()) => buildReportModel({ seeds: pointState.seeds, activePointIds: pointState.activePointIds, tracksByPoint: new Map([...pointState.tracksByPoint.entries()].map(([id, rows]) => [id, [...rows]])), registrations: [...pointState.registrations], recoveryEvents: [...pointState.recoveryEvents], riskNotices: [...pointState.riskNotices], processingStats: { ...pointState.processingStats }, frameLedger: pointState.frameLedger.map(entry => ({ ...entry })), events: [...events] }, metadata, thresholds, options);
  const openReport = () => { try { setReportModel(snapshotReport()); setReportOpen(true); } catch (error) { addRisk({ code: "export.failed", severity: "warning", frame: frameRef.current, message: error instanceof Error ? error.message : "报告阈值无效", action: "retry", recoverable: true }); } };
  const refreshReport = (metadata: ReportMetadata, thresholds: QualityThresholds, options: ReportOptions) => { try { localStorage.setItem("subpixel.report.metadata.v1", JSON.stringify({ projectName: metadata.projectName, testId: metadata.testId, operator: metadata.operator, notes: metadata.notes })); localStorage.setItem("subpixel.report.thresholds.v1", JSON.stringify(thresholds)); localStorage.setItem("subpixel.report.options.v1", JSON.stringify(options)); } catch { /* local preferences are optional */ } setReportModel(snapshotReport({ ...metadata, generatedAt: new Date().toISOString() }, thresholds, options)); };
  const applyRecovery = (correspondences: AnchorCorrespondence[]) => {
    const tracker = trackerRef.current;
    if (!tracker || correspondences.length < 4 || !sourceSize || !image) return;
    const anchors = correspondences.map(anchor => ({ reference: anchor.reference, current: anchor.current, reliable: anchor.confidence >= .5 }));
    const quality = evaluateRecoveryAnchors(anchors, sourceSize);
    if (!quality.accepted) {
      addRisk({ code: "tracking.lost", severity: "error", frame: frameRef.current, message: quality.reason ?? "恢复锚点未通过质量门控", action: "select-anchors", recoverable: true });
      return;
    }
    recoverySnapshotRef.current = captureRecoverySnapshot({
      tracker: tracker.snapshot(), positions: positionsRef.current, referencePositions: referencePositionsRef.current,
      templates: templatesRef.current, previousSearches: previousSearchesRef.current,
      keyframeFrame: keyframeFrameRef.current?.frame ?? 0, running: runningRef.current, recoveryPaused
    });
    recoveryPointStateSnapshotRef.current = clonePointSetState(pointState);
    recoveryKeyframeFrameSnapshotRef.current = keyframeFrameRef.current;

    const anchorById = new Map(correspondences.map(anchor => [anchor.pointId, anchor.current]));
    const recoveredPositions = new Map<string, { x: number; y: number }>();
    for (const seed of seedsRef.current) {
      const direct = anchorById.get(seed.pointId);
      const propagated = direct ? { accepted: true, point: direct } : applyLocalAffine(seed.snapped, anchors);
      if (!propagated.accepted) {
        addRisk({ code: "tracking.lost", severity: "error", frame: frameRef.current, pointId: seed.pointId, message: `${seed.pointId} 无法通过恢复锚点传播`, action: "select-anchors", recoverable: true });
        return;
      }
      recoveredPositions.set(seed.pointId, { ...propagated.point });
    }

    tracker.applyAnchors(anchors);
    positionsRef.current = recoveredPositions;
    referencePositionsRef.current = new Map([...recoveredPositions].map(([pointId, point]) => [pointId, { ...point }]));
    templatesRef.current = new Map();
    previousSearchesRef.current = new Map();
    for (const seed of seedsRef.current) {
      const position = recoveredPositions.get(seed.pointId)!;
      const templateRoi = trackingTemplateRoi(seed, sourceSize, position);
      const template = extractNativePatch(image, templateRoi);
      templatesRef.current.set(seed.pointId, template);
      const radius = seed.model === "natural-keypoint" ? Math.min(192, Math.max(24, Math.max(template.width, template.height) * 1.5)) : Math.max(10, Math.min(96, Math.max(template.width, template.height) * .5));
      const searchRoi = normalizeNativeRoi({ x: position.x - template.width / 2 - radius, y: position.y - template.height / 2 - radius, width: template.width + radius * 2, height: template.height + radius * 2 }, sourceSize);
      previousSearchesRef.current.set(seed.pointId, { patch: extractNativePatch(image, searchRoi), roi: searchRoi });
    }
    keyframeFrameRef.current = { frame: frameRef.current, timestampMs: performance.now(), width: sourceSize.width, height: sourceSize.height, source: cameraActive ? "camera" : "image", image };
    previousTrackingFrameRef.current = keyframeFrameRef.current;
    adjacentChainRef.current = undefined;
    const event: RecoveryEvent = { id: `recovery-applied-${Date.now()}`, frame: frameRef.current, kind: "applied", anchorCount: anchors.length, coverage: quality.coverage, inlierRatio: 1, predictedMedianError: quality.predictedMedianError ?? 0, reversible: true, message: "已建立新的受控关键帧" };
    setPointState(state => appendRecoveryEvent(state, event));
    setRecoveryPaused(false); setRecoveryUndoAvailable(true); runningRef.current = true; setRunning(true); setMode("track");
  };
  const rollbackRecovery = () => {
    const snapshot = recoverySnapshotRef.current;
    const pointSnapshot = recoveryPointStateSnapshotRef.current;
    const tracker = trackerRef.current;
    if (!snapshot || !pointSnapshot || !tracker) {
      runningRef.current = false; setRunning(false); setRecoveryPaused(true); setMode("recover");
      return;
    }
    const restored = restoreRecoverySnapshot(snapshot);
    tracker.restore(restored.tracker);
    positionsRef.current = restored.positions;
    referencePositionsRef.current = restored.referencePositions;
    templatesRef.current = restored.templates;
    previousSearchesRef.current = restored.previousSearches;
    keyframeFrameRef.current = recoveryKeyframeFrameSnapshotRef.current;
    previousTrackingFrameRef.current = keyframeFrameRef.current;
    adjacentChainRef.current = undefined;
    const event: RecoveryEvent = { id: `recovery-rollback-${Date.now()}`, frame: frameRef.current, kind: "rolled-back", anchorCount: 0, coverage: 0, inlierRatio: 0, predictedMedianError: 0, reversible: false, message: "已恢复到人工恢复前的暂停状态" };
    setPointState(current => ({ ...clonePointSetState(pointSnapshot), recoveryEvents: [...current.recoveryEvents, event] }));
    recoverySnapshotRef.current = undefined; recoveryPointStateSnapshotRef.current = undefined; recoveryKeyframeFrameSnapshotRef.current = undefined;
    runningRef.current = false; setRunning(false); setRecoveryPaused(true); setRecoveryUndoAvailable(false); setMode("recover");
  };
  const exportResult = async (format: ExportFormat, options?: ExportOptions): Promise<ExportResult | undefined> => {
    try {
      return await exportTracking(format, { roi: draft?.roi ?? pointState.seeds[0]?.roi ?? { x: 0, y: 0, width: 1, height: 1 }, model: intentToModel(intent), tracks: legacyTracks, multiTracks: flattenTracks(pointState), points: pointState.seeds, registrations: pointState.registrations, recoveryEvents: pointState.recoveryEvents, riskNotices: pointState.riskNotices, processingStats: pointState.processingStats, events, image, referenceImage, currentImage: image, reportModel }, options);
    } catch (error) {
      addRisk({ code: "export.failed", severity: "error", frame: frameRef.current, message: error instanceof Error ? error.message : "Export failed", action: "export-current", recoverable: true });
      if (options) throw error;
      return undefined;
    }
  };

  const allTracks = flattenTracks(pointState);
  const latestTracks = [...pointState.tracksByPoint.values()].map(items => items.at(-1)).filter((track): track is MultiPointTrack => Boolean(track));
  const displayedTracks = mode === "review" ? tracksForFrame(allTracks, reviewFrame) : latestTracks;
  const updateAlertSettings = (input: AlertSettings) => {
    const next = normalizeAlertSettings(input);
    alertSettingsRef.current = next;
    trackerRef.current?.setPauseLostRatio(next.pauseInvalidRatio);
    setAlertSettings(next);
    saveAlertSettings(typeof window === "undefined" ? undefined : window.localStorage, next);
    setPointState(state => clearRiskNotices(state, notice => notice.code === "tracking.identity-gate-failed" || notice.code === "registration.rejected"));
  };
  const reviewDecision = (pointId: string, frame: number, decision: "accept" | "reject") => {
    const updated = setTrackReviewDecision(pointState, pointId, frame, decision);
    setPointState(updated);
    if (decision === "accept") setPendingReviewAdvance({ pointId, frame });
    addEvent({ id: `review-${decision}-${pointId}-${frame}-${Date.now()}`, frame, kind: "reviewed", message: `${pointId} ${decision === "accept" ? "确认正确" : "标记异常"}`, recoverable: decision === "reject" });
  };
  const changeMode = (next: CanvasMode) => {
    setReviewPlaying(false);
    setMode(next);
    if (cameraActive && next !== "review" && !draft) cameraPreviewFrozenRef.current = false;
    if (next === "review") {
      const last = pointState.frameLedger.filter(entry => entry.frame !== null).at(-1)?.frame;
      if (last !== undefined && last !== null && last !== reviewFrame) void selectReviewFrame(last);
      setSelectedPointId(current => current ?? pointState.seeds[0]?.pointId);
    }
  };
  const cameraSession: CameraSession = pointState.cameraSession;
  const degradedTrackingRequired = !canStartTrackingInEngineMode(engineStatus, false);
  return <div>
    <video ref={cameraVideoRef} className="camera-video-source" muted playsInline aria-hidden="true" />
    <TrackingWorkbench
      image={image} referenceImage={referenceImage} currentImage={image} sourceSize={sourceSize}
      draft={draft} intent={intent} onIntentChange={setIntent} onSelectionChange={onSelectionChange}
      onConfirmDraft={confirmDraft} onDeleteDraft={deleteDraft} onDeleteSeed={deleteSeed}
      onReinitialize={reinitialize} onUndoDelete={undoDelete} canUndoDelete={Boolean(deletedSeed)}
      mode={mode} onModeChange={changeMode} seeds={pointState.seeds} multiTracks={displayedTracks}
      tracks={allTracks} events={events} running={running} onToggle={toggleTracking}
      onFiles={selectFiles} onExport={exportResult}
      onReview={(pointId, frame) => reviewDecision(pointId, frame, "accept")}
      reviewFrame={reviewFrame} reviewPlaying={reviewPlaying} reviewLoading={reviewLoading}
      selectedPointId={selectedPointId} reinitializingPointId={reinitializing?.pointId}
      onSelectPoint={setSelectedPointId}
      onSelectReviewFrame={frame => void selectReviewFrame(frame)}
      onMoveReviewFrame={direction => void selectReviewFrame(moveReviewFrame(pointState.frameLedger, reviewFrame, direction))}
      onToggleReviewPlayback={() => setReviewPlaying(value => !value)}
      onReviewDecision={reviewDecision}
      alertSettings={alertSettings} onAlertSettingsChange={updateAlertSettings}
      recoveryPaused={recoveryPaused} recoveryUndoAvailable={recoveryUndoAvailable}
      onApplyRecovery={applyRecovery} onRollbackRecovery={rollbackRecovery}
      onOpenCamera={() => void openCamera()} cameraActive={cameraActive} cameraSession={cameraSession}
      facingMode={facingMode} onSwitchCamera={() => {
        const next = facingMode === "environment" ? "user" : "environment";
        setFacingMode(next); cameraSourceRef.current?.stop(); cameraSourceRef.current = undefined;
        if (cameraActive) window.setTimeout(() => void openCamera(next), 0);
      }}
      recordingActive={recordingActive} onToggleRecording={toggleRecording}
      recordingReady={Boolean(pointState.recording.blob)} onRefineRecording={() => void refineRecording()}
      riskNotices={pointState.riskNotices} processingStats={pointState.processingStats}
      frameLedger={pointState.frameLedger}
      degradedTrackingRequired={degradedTrackingRequired} degradedTrackingConfirmed={degradedTrackingConfirmed}
      onConfirmDegradedTracking={() => setDegradedTrackingConfirmed(true)}
      report={reportModel} reportOpen={reportOpen} onOpenReport={openReport}
      onCloseReport={() => setReportOpen(false)} onRefreshReport={refreshReport}
    />
  </div>;
}
