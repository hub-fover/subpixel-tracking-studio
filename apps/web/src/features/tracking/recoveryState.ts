import type { GrayPatch, MultiPointTrackerSnapshot } from "@subpixel/algorithms";
import type { Point, Roi } from "@subpixel/contracts";

export type RecoverySearch = { patch: GrayPatch; roi: Roi };

export type RecoverySnapshot = {
  tracker: MultiPointTrackerSnapshot;
  positions: Map<string, Point>;
  referencePositions: Map<string, Point>;
  templates: Map<string, GrayPatch>;
  previousSearches: Map<string, RecoverySearch>;
  keyframeFrame: number;
  running: boolean;
  recoveryPaused: boolean;
};

function clonePatch(patch: GrayPatch): GrayPatch {
  return { width: patch.width, height: patch.height, data: new Float32Array(patch.data) };
}

function clonePositions(positions: Map<string, Point>) {
  return new Map([...positions].map(([pointId, point]) => [pointId, { ...point }]));
}

function cloneTracker(snapshot: MultiPointTrackerSnapshot): MultiPointTrackerSnapshot {
  return { frame: snapshot.frame, paused: snapshot.paused, positions: snapshot.positions.map(([pointId, point]) => [pointId, { ...point }] as const) };
}

function cloneSnapshot(snapshot: RecoverySnapshot): RecoverySnapshot {
  return {
    ...snapshot,
    tracker: cloneTracker(snapshot.tracker),
    positions: clonePositions(snapshot.positions),
    referencePositions: clonePositions(snapshot.referencePositions),
    templates: new Map([...snapshot.templates].map(([pointId, patch]) => [pointId, clonePatch(patch)])),
    previousSearches: new Map([...snapshot.previousSearches].map(([pointId, search]) => [pointId, { roi: { ...search.roi }, patch: clonePatch(search.patch) }]))
  };
}

export function captureRecoverySnapshot(input: RecoverySnapshot): RecoverySnapshot {
  return cloneSnapshot(input);
}

export function restoreRecoverySnapshot(snapshot: RecoverySnapshot): RecoverySnapshot {
  return cloneSnapshot(snapshot);
}
