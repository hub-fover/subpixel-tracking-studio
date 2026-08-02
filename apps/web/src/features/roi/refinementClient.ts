import { FeatureRefinementSchema, type ExtractionIntent, type Roi } from "@subpixel/contracts";

type RefinementRequest = {
  patch: Blob;
  intent: ExtractionIntent;
  roi: Roi;
  sourceSize: { width: number; height: number };
};

const apiBase = import.meta.env.VITE_API_BASE ?? "";

export async function refineFeature(
  request: RefinementRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const form = new FormData();
  form.set("patch", request.patch, "roi.png");
  form.set("intent", request.intent);
  form.set("roi_x", String(request.roi.x));
  form.set("roi_y", String(request.roi.y));
  form.set("roi_width", String(Math.round(request.roi.width)));
  form.set("roi_height", String(Math.round(request.roi.height)));
  form.set("source_width", String(request.sourceSize.width));
  form.set("source_height", String(request.sourceSize.height));
  const response = await fetcher(`${apiBase}/api/features/refine`, { method: "POST", body: form, signal });
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined);
    throw Object.assign(new Error(detail?.detail?.code ?? `refinement.http-${response.status}`), {
      code: detail?.detail?.code ?? "refinement.request-failed",
      recoverable: response.status < 500,
    });
  }
  return FeatureRefinementSchema.parse(await response.json());
}
