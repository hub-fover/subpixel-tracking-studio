import { Delaunay } from "d3-delaunay";
import type { PointSeed, PointTopologyEdge } from "@subpixel/contracts";

function edgeId(groupId: string, left: string, right: string) {
  const [sourcePointId, targetPointId] = [left, right].sort((a, b) => a.localeCompare(b));
  return { edgeId: `${groupId}:${sourcePointId}--${targetPointId}`, sourcePointId, targetPointId };
}

export function buildFixedTopology(seeds: PointSeed[], disabledEdgeIds: Iterable<string> = []): PointTopologyEdge[] {
  const disabled = new Set(disabledEdgeIds);
  const groups = new Map<string, PointSeed[]>();
  for (const seed of seeds) groups.set(seed.groupId, [...(groups.get(seed.groupId) ?? []), seed]);
  const edges = new Map<string, PointTopologyEdge>();
  const add = (groupId: string, left: PointSeed | undefined, right: PointSeed | undefined) => {
    if (!left || !right) return;
    if (left.pointId === right.pointId) return;
    const identity = edgeId(groupId, left.pointId, right.pointId);
    if (edges.has(identity.edgeId)) return;
    edges.set(identity.edgeId, {
      ...identity,
      groupId,
      referenceLengthPx: Math.hypot(left.snapped.x - right.snapped.x, left.snapped.y - right.snapped.y),
      enabled: !disabled.has(identity.edgeId)
    });
  };
  for (const [groupId, points] of groups) {
    const ordered = [...points].sort((a, b) => a.pointId.localeCompare(b.pointId));
    if (ordered.length === 2) {
      add(groupId, ordered[0], ordered[1]);
      continue;
    }
    if (ordered.length < 3) continue;
    const delaunay = Delaunay.from(ordered, point => point.snapped.x, point => point.snapped.y);
    for (let pointIndex = 0; pointIndex < ordered.length; pointIndex += 1) {
      for (const neighborIndex of delaunay.neighbors(pointIndex)) add(groupId, ordered[pointIndex], ordered[neighborIndex]);
    }
  }
  return [...edges.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}
