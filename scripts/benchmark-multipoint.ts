import { writeFileSync } from "node:fs";
import { createMultiPointTracker, matchTemplateNcc, type GrayPatch, type MultiPointObservation } from "../packages/algorithms/src/index";
import type { PointSeed } from "../packages/contracts/src/index";

const seeds: PointSeed[] = Array.from({ length: 100 }, (_, index) => ({ pointId: `p-${index + 1}`, click: { x: 20 + index % 10 * 50, y: 20 + Math.floor(index / 10) * 40 }, snapped: { x: 20 + index % 10 * 50, y: 20 + Math.floor(index / 10) * 40 }, roi: { x: 10, y: 10, width: 24, height: 24 }, groupId: "benchmark", candidateScore: .9, model: index % 2 ? "natural-keypoint" : "crosshair" }));
const tracker = createMultiPointTracker(seeds); tracker.initialize();
const template: GrayPatch = { width: 11, height: 11, data: Float32Array.from({ length: 121 }, (_, index) => { const x = index % 11; const y = Math.floor(index / 11); return Math.exp(-((x - 5) ** 2 + (y - 5) ** 2) / 12) * 255; }) };
const search: GrayPatch = { width: 19, height: 19, data: Float32Array.from({ length: 361 }, (_, index) => { const x = index % 19; const y = Math.floor(index / 19); return Math.exp(-((x - 9.2) ** 2 + (y - 8.8) ** 2) / 12) * 255; }) };
const started = performance.now(); const frames = 60;
for (let frame = 0; frame < frames; frame += 1) {
  const observations: MultiPointObservation[] = seeds.map(seed => { const refined = matchTemplateNcc(search, template); return { pointId: seed.pointId, predicted: { x: seed.snapped.x + frame * .1, y: seed.snapped.y }, refined: { x: seed.roi.x + refined.x, y: seed.roi.y + refined.y }, confidence: refined.ncc, residual: refined.residual, relocationMethod: "local-correlation", metrics: seed.model === "natural-keypoint" ? { forwardBackwardError: .3, ncc: refined.ncc, epipolarError: .7, loweRatio: 1 - refined.ncc } : undefined }; });
  tracker.process(observations, frame * 33.3, { matchCount: 100, inlierRatio: .8, medianReprojectionError: 1 });
}
const elapsedMs = performance.now() - started; const result = { pointCount: seeds.length, frames, elapsedMs, fps: frames / (elapsedMs / 1000), targetFps: 15, passed: frames / (elapsedMs / 1000) >= 15 };
const outputIndex = process.argv.indexOf("--output"); if (outputIndex >= 0 && process.argv[outputIndex + 1]) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
