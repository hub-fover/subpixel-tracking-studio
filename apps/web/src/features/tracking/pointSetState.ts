import type { CameraSession, FrameLedgerEntry, FrameRegistration, MultiPointTrack, PointSeed, ProcessingStats, RecoveryEvent, RiskNotice } from "@subpixel/contracts";

export type PointSetState = {
  seeds: PointSeed[];
  tracksByPoint: Map<string, MultiPointTrack[]>;
  registrations: FrameRegistration[];
  recoveryEvents: RecoveryEvent[];
  activePointIds: string[];
  riskNotices: RiskNotice[];
  cameraSession: CameraSession;
  processingStats: ProcessingStats;
  frameLedger: FrameLedgerEntry[];
  referenceFrame?: { width: number; height: number; timestampMs: number };
  recording: { active: boolean; mimeType: string | null; blob: Blob | null; durationMs: number | null };
};

export function createPointSetState(seeds: PointSeed[] = []): PointSetState {
  return {
    seeds: [...seeds], tracksByPoint: new Map(), registrations: [], recoveryEvents: [], activePointIds: seeds.map(seed => seed.pointId),
    riskNotices: [],
    cameraSession: { status: "idle", facingMode: "environment", nativeWidth: null, nativeHeight: null, recording: false, error: null },
    processingStats: { processedFrames: 0, droppedFrames: 0, fps: 0, p95LatencyMs: 0, engine: "typescript", nativeWidth: null, nativeHeight: null },
    frameLedger: [],
    recording: { active: false, mimeType: null, blob: null, durationMs: null }
  };
}

export function pointRows(state: PointSetState): PointSeed[] {
  return state.seeds.filter(seed => state.activePointIds.includes(seed.pointId)).sort((a, b) => a.pointId.localeCompare(b.pointId));
}

export function appendTracks(state: PointSetState, tracks: MultiPointTrack[]): PointSetState {
  const next = new Map(state.tracksByPoint);
  for (const track of tracks) {
    const existing = next.get(track.pointId) ?? [];
    next.set(track.pointId, [...existing.filter(item => item.frame !== track.frame), track].sort((a, b) => a.frame - b.frame));
  }
  return { ...state, tracksByPoint: next };
}

export function flattenTracks(state: PointSetState): MultiPointTrack[] {
  return [...state.tracksByPoint.values()].flat().sort((a, b) => a.frame - b.frame || a.pointId.localeCompare(b.pointId));
}

export function reviewTrack(state: PointSetState, pointId: string, frame: number): PointSetState {
  const tracks = state.tracksByPoint.get(pointId);
  if (!tracks?.some(track => track.frame === frame && track.state !== "reviewed")) return state;

  const tracksByPoint = new Map(state.tracksByPoint);
  tracksByPoint.set(pointId, tracks.map(track => track.frame === frame ? { ...track, state: "reviewed" as const } : track));
  return { ...state, tracksByPoint };
}

export function appendRegistration(state: PointSetState, registration: FrameRegistration): PointSetState {
  return { ...state, registrations: [...state.registrations.filter(item => item.frame !== registration.frame), registration].sort((a, b) => a.frame - b.frame) };
}

export function appendFrameLedgerEntry(state: PointSetState, entry: FrameLedgerEntry): PointSetState {
  return {
    ...state,
    frameLedger: [...state.frameLedger.filter(item => item.inputIndex !== entry.inputIndex), entry]
      .sort((left, right) => left.inputIndex - right.inputIndex)
  };
}

export function appendRecoveryEvent(state: PointSetState, event: RecoveryEvent): PointSetState {
  return { ...state, recoveryEvents: [...state.recoveryEvents.filter(item => item.id !== event.id), event] };
}

export function appendRiskNotice(state: PointSetState, notice: RiskNotice): PointSetState {
  return { ...state, riskNotices: [...state.riskNotices.filter(item => item.id !== notice.id), { ...notice, createdAt: notice.createdAt ?? Date.now() }].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)) };
}

export function clonePointSetState(state: PointSetState): PointSetState {
  return {
    ...state,
    seeds: state.seeds.map(seed => ({
      ...seed,
      click: { ...seed.click }, snapped: { ...seed.snapped }, roi: { ...seed.roi },
      geometry: seed.geometry ? structuredClone(seed.geometry) : undefined,
      quality: seed.quality ? { ...seed.quality, gates: { ...seed.quality.gates } } : undefined,
      template: seed.template ? { ...seed.template, descriptor: [...seed.template.descriptor], gradientTemplate: [...seed.template.gradientTemplate], topology: [...seed.template.topology] } : undefined
    })),
    tracksByPoint: new Map([...state.tracksByPoint].map(([pointId, tracks]) => [pointId, tracks.map(track => ({ ...track, predicted: { ...track.predicted }, refined: { ...track.refined }, gateFailures: [...track.gateFailures] }))])),
    registrations: state.registrations.map(registration => ({ ...registration, transform: registration.transform ? { ...registration.transform, matrix: [...registration.transform.matrix] } : undefined, inverseTransform: registration.inverseTransform ? { ...registration.inverseTransform, matrix: [...registration.inverseTransform.matrix] } : undefined, fundamentalMatrix: registration.fundamentalMatrix ? [...registration.fundamentalMatrix] : undefined })),
    recoveryEvents: state.recoveryEvents.map(event => ({ ...event })),
    activePointIds: [...state.activePointIds],
    riskNotices: state.riskNotices.map(notice => ({ ...notice })),
    cameraSession: { ...state.cameraSession },
    processingStats: { ...state.processingStats },
    frameLedger: state.frameLedger.map(entry => ({ ...entry })),
    referenceFrame: state.referenceFrame ? { ...state.referenceFrame } : undefined,
    recording: { ...state.recording }
  };
}

export function clearRiskNotices(state: PointSetState, predicate: (notice: RiskNotice) => boolean): PointSetState {
  return { ...state, riskNotices: state.riskNotices.filter(notice => !predicate(notice)) };
}

export function summarizeProcessing(input: { processedFrames: number; droppedFrames: number; latencies: number[]; nativeWidth: number | null; nativeHeight: number | null; engine: ProcessingStats["engine"] }): ProcessingStats {
  const values = [...input.latencies].sort((a, b) => a - b);
  const p95 = values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * .95) - 1)] : 0;
  const elapsedSeconds = values.reduce((sum, value) => sum + value, 0) / 1000;
  return {
    processedFrames: input.processedFrames,
    droppedFrames: input.droppedFrames,
    fps: elapsedSeconds > 0 ? input.processedFrames / elapsedSeconds : 0,
    p95LatencyMs: p95,
    engine: input.engine,
    nativeWidth: input.nativeWidth,
    nativeHeight: input.nativeHeight
  };
}
