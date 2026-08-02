import { performance } from "node:perf_hooks";
import { circleModel, makeCirclePatch } from "@subpixel/algorithms";

const frames = Number(process.argv[process.argv.indexOf("--frames") + 1] ?? 300);
const patch = makeCirclePatch({ center: { x: 16.35, y: 15.7 }, radius: 6 });
const started = performance.now();
for (let frame = 0; frame < frames; frame += 1) circleModel.refineSubpixel(patch);
const elapsed = performance.now() - started;
const fps = frames / (elapsed / 1000);
console.log(JSON.stringify({ frames, elapsedMs: elapsed, fps }));
if (fps < 30) process.exitCode = 1;
