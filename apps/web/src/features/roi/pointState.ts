import type { ExtractionIntent, FeatureDraft, FeatureModelType, PointSeed } from "@subpixel/contracts";

export function nextPointId(ids: string[]) {
  const highest = ids.reduce((max, id) => {
    const match = /^p-(\d+)$/.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `p-${String(highest + 1).padStart(3, "0")}`;
}

export function intentToModel(intent: ExtractionIntent): FeatureModelType {
  if (intent === "circle-center") return "circle";
  if (intent === "crosshair-center") return "crosshair";
  if (intent === "diagonal-center") return "diagonal";
  if (intent === "blob-center") return "blob";
  if (intent === "speckle-center") return "speckle";
  return "natural-keypoint";
}

export function confirmFeatureDraft(draft: FeatureDraft, pointId: string): PointSeed | null {
  const refinement = draft.refinement;
  if (draft.status !== "ready" || !refinement?.accepted || !refinement.point) return null;
  const model = intentToModel(draft.intent);
  return {
    pointId,
    click: refinement.point,
    snapped: refinement.point,
    roi: refinement.roi,
    groupId: model === "natural-keypoint" ? "natural" : "cooperative",
    candidateScore: refinement.confidence,
    model,
    selectionMethod: "roi",
    intent: draft.intent,
    geometry: refinement.geometry,
    quality: {
      confidence: refinement.confidence,
      residualPx: refinement.residualPx,
      gates: refinement.gates,
    },
  };
}
