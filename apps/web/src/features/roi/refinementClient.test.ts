import { expect, it, vi } from "vitest";

import { refineFeature } from "./refinementClient";

it("sends the native ROI patch and parses original-coordinate refinement", async () => {
  const response = {
    accepted: false, intent: "circle-center", roi: { x: 100, y: 200, width: 20, height: 24 },
    point: null, confidence: 0, residualPx: null, gates: { completeGeometry: false },
    reason: "refinement.incomplete-geometry", geometry: null
  };
  const fetcher: typeof fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init).toBeDefined();
    const form = init!.body as FormData;
    expect(form.get("roi_x")).toBe("100");
    expect(form.get("roi_width")).toBe("20");
    expect(form.get("intent")).toBe("circle-center");
    expect((form.get("patch") as Blob).size).toBe(3);
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await refineFeature({
    patch: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), intent: "circle-center",
    roi: { x: 100, y: 200, width: 20, height: 24 }, sourceSize: { width: 1000, height: 800 }
  }, undefined, fetcher);
  expect(result.reason).toBe("refinement.incomplete-geometry");
  expect(fetcher).toHaveBeenCalledOnce();
});
