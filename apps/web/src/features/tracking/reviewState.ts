import type { FrameLedgerEntry, MultiPointTrack, PointSeed } from "@subpixel/contracts";

export type FrameReviewRow = { pointId: string; seed: PointSeed; track?: MultiPointTrack };

export function tracksForFrame(tracks: MultiPointTrack[], frame: number): MultiPointTrack[] {
  return tracks.filter(track => track.frame === frame).sort((left, right) => left.pointId.localeCompare(right.pointId));
}

export function buildFrameReviewRows(seeds: PointSeed[], tracks: MultiPointTrack[], frame: number): FrameReviewRow[] {
  const byPoint = new Map(tracksForFrame(tracks, frame).map(track => [track.pointId, track]));
  return [...seeds].sort((left, right) => left.pointId.localeCompare(right.pointId)).map(seed => ({ pointId: seed.pointId, seed, track: byPoint.get(seed.pointId) }));
}

export function moveReviewFrame(ledger: FrameLedgerEntry[], current: number, direction: -1 | 1): number {
  const frames = ledger.flatMap(entry => entry.frame === null ? [] : [entry.frame]).sort((left, right) => left - right);
  if (!frames.length) return current;
  const index = frames.indexOf(current);
  if (index < 0) return direction > 0 ? frames.find(frame => frame > current) ?? frames.at(-1)! : [...frames].reverse().find(frame => frame < current) ?? frames[0];
  return frames[Math.max(0, Math.min(frames.length - 1, index + direction))];
}
