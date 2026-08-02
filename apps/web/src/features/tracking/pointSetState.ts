import type { FrameRegistration, MultiPointTrack, PointSeed, RecoveryEvent } from "@subpixel/contracts";

export type PointSetState = {
  seeds: PointSeed[];
  tracksByPoint: Map<string, MultiPointTrack[]>;
  registrations: FrameRegistration[];
  recoveryEvents: RecoveryEvent[];
  activePointIds: string[];
};

export function createPointSetState(seeds: PointSeed[] = []): PointSetState {
  return { seeds: [...seeds], tracksByPoint: new Map(), registrations: [], recoveryEvents: [], activePointIds: seeds.map(seed => seed.pointId) };
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

export function appendRegistration(state: PointSetState, registration: FrameRegistration): PointSetState {
  return { ...state, registrations: [...state.registrations.filter(item => item.frame !== registration.frame), registration].sort((a, b) => a.frame - b.frame) };
}

export function appendRecoveryEvent(state: PointSetState, event: RecoveryEvent): PointSetState {
  return { ...state, recoveryEvents: [...state.recoveryEvents.filter(item => item.id !== event.id), event] };
}
