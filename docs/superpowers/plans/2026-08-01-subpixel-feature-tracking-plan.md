# 多特征亚像素提取与跟踪工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可运行的响应式 Web 原型，支持文件/实时相机输入、首帧 ROI 初始化、多种特征的亚像素提取与跟踪、质量复核以及 CSV/JSON/XLSX/PDF/标注媒体导出。

**Architecture:** 采用 pnpm monorepo。`packages/contracts` 定义前后端共享的 Zod/JSON Schema 契约；`packages/algorithms` 提供 TypeScript 本地快速路径并通过 Web Worker 执行；`services/api` 提供 FastAPI 后端精算/报告接口；`apps/web` 提供 React 工作台。所有执行路径输出同一 `PointTrack[]`。

**Tech Stack:** TypeScript 5、React 18、Vite、Vitest、Playwright、Web Workers、Canvas 2D、MediaDevices/WebRTC、Python 3.11、FastAPI、Pydantic v2、NumPy、OpenCV、pytest、ReportLab、openpyxl。

---

## 文件结构锁定

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`: monorepo 脚本、workspace 和 TypeScript 基础配置。
- `packages/contracts/src/index.ts`, `packages/contracts/src/schema.ts`: `TrackingJob`、`PointTrack`、`TrackingEvent`、`ReportManifest` 类型和运行时校验。
- `packages/algorithms/src/preprocess.ts`, `feature-models.ts`, `tracker.ts`, `fixtures.ts`: 本地预处理、特征模型、预测/校正跟踪和合成样本。
- `packages/algorithms/src/__tests__/*.test.ts`: 算法单元/合成数据测试。
- `apps/web/src/features/capture`, `roi`, `tracking`, `report`: 输入适配、首帧 ROI、工作台状态和导出 UI；`apps/web/src/workers/tracker.worker.ts` 隔离计算。
- `services/api/app/main.py`, `schemas.py`, `jobs.py`, `algorithms.py`, `reports.py`: FastAPI 路由、Pydantic schema、任务执行、OpenCV 精算和报告服务。
- `services/api/tests`: 后端 schema、算法和接口测试。
- `apps/web/e2e/tracking.spec.ts`, `apps/web/e2e/fixtures`: Playwright 端到端与模拟视频流。

### Task 1: 初始化可运行 monorepo 与契约测试

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/schema.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/schema.test.ts`
- Create: `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`
- Create: `services/api/pyproject.toml`, `services/api/app/__init__.py`, `services/api/app/main.py`

- [ ] **Step 1: 写契约失败测试**

```ts
// packages/contracts/src/schema.test.ts
import { describe, expect, it } from "vitest";
import { TrackingJobSchema, PointTrackSchema } from "./schema";

describe("tracking contracts", () => {
  it("accepts a local job with ROI and feature model", () => {
    const result = TrackingJobSchema.safeParse({
      id: "job-1", mode: "local", source: { kind: "image-sequence", name: "frames" },
      frameRange: { start: 0, end: 9, sampleRate: 1 },
      roi: { x: 10, y: 20, width: 40, height: 40 },
      model: { type: "circle", locked: true, params: {} },
      calibration: null, exports: ["json"]
    });
    expect(result.success).toBe(true);
  });

  it("rejects a point with a non-finite coordinate", () => {
    expect(PointTrackSchema.safeParse({ frame: 0, timestampMs: 0, x: NaN, y: 2,
      model: "circle", residual: 0, confidence: 1, state: "valid", durationMs: 1
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @subpixel/contracts test -- schema.test.ts`
Expected: FAIL because the package and schemas do not exist.

- [ ] **Step 3: 实现 schema 与 workspace 最小配置**

```ts
// packages/contracts/src/schema.ts
import { z } from "zod";
export const RoiSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() });
export const TrackingJobSchema = z.object({
  id: z.string().min(1), mode: z.enum(["local", "server"]),
  source: z.object({ kind: z.enum(["image-sequence", "video", "camera"]), name: z.string() }),
  frameRange: z.object({ start: z.number().int().nonnegative(), end: z.number().int().gte(0), sampleRate: z.number().positive() }),
  roi: RoiSchema, model: z.object({ type: z.enum(["circle", "blob", "crosshair", "diagonal", "speckle"]), locked: z.boolean(), params: z.record(z.number()) }),
  calibration: z.object({ pixelSize: z.number().positive(), unit: z.string() }).nullable(), exports: z.array(z.enum(["csv", "json", "xlsx", "pdf", "images", "video"]))
});
export const PointTrackSchema = z.object({ frame: z.number().int().nonnegative(), timestampMs: z.number().nonnegative(), x: z.number().finite(), y: z.number().finite(), z: z.number().finite().optional(), model: z.string(), residual: z.number().nonnegative(), confidence: z.number().min(0).max(1), state: z.enum(["valid", "suspect", "lost", "reviewed"]), durationMs: z.number().nonnegative() });
export const TrackingEventSchema = z.object({ id: z.string(), frame: z.number().int().nonnegative(), kind: z.enum(["initialized", "model-switched", "low-confidence", "lost", "reconnected", "reviewed", "export-failed"]), message: z.string(), recoverable: z.boolean() });
export const ReportManifestSchema = z.object({ jobId: z.string(), algorithmVersion: z.string(), summary: z.record(z.number()), assets: z.array(z.object({ kind: z.string(), path: z.string() })), parameters: z.record(z.unknown()) });
export type TrackingJob = z.infer<typeof TrackingJobSchema>;
export type PointTrack = z.infer<typeof PointTrackSchema>;
export type TrackingEvent = z.infer<typeof TrackingEventSchema>;
export type ReportManifest = z.infer<typeof ReportManifestSchema>;
```

Set `package.json` scripts to `test`, `typecheck`, `dev`, and `build`; configure Vitest and the `@subpixel/contracts` package export. Add the minimal Vite React shell and a FastAPI `/health` route returning `{ "status": "ok" }`.

- [ ] **Step 4: 运行契约、类型和健康检查**

Run: `pnpm install; pnpm --filter @subpixel/contracts test; pnpm -r typecheck; python -m pytest services/api/tests -q`
Expected: contract tests PASS, TypeScript typecheck PASS, and `/health` test PASS.

- [ ] **Step 5: Commit**

Run: `git add package.json pnpm-workspace.yaml tsconfig.base.json packages/contracts apps/web services/api; git commit -m "chore: scaffold subpixel tracking workspace"`

### Task 2: 实现预处理、合成样本与 FeatureModel 接口

**Files:**
- Create: `packages/algorithms/package.json`
- Create: `packages/algorithms/src/types.ts`
- Create: `packages/algorithms/src/preprocess.ts`
- Create: `packages/algorithms/src/feature-models.ts`
- Create: `packages/algorithms/src/fixtures.ts`
- Create: `packages/algorithms/src/__tests__/preprocess.test.ts`
- Create: `packages/algorithms/src/__tests__/feature-models.test.ts`

- [ ] **Step 1: 写预处理和模型失败测试**

```ts
it("normalizes a patch without changing its center", () => {
  const patch = makeCirclePatch({ center: { x: 12.35, y: 11.7 }, radius: 5 });
  const normalized = normalizePatch(patch);
  expect(normalized.length).toBe(patch.length);
  expect(normalized.reduce((a, b) => a + b, 0) / normalized.length).toBeCloseTo(0, 5);
});

it("fits a circle center within 0.1 px on synthetic data", () => {
  const result = circleModel.refineSubpixel(makeCirclePatch({ center: { x: 16.35, y: 15.7 }, radius: 6 }));
  expect(Math.hypot(result.x - 16.35, result.y - 15.7)).toBeLessThanOrEqual(0.1);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @subpixel/algorithms test -- feature-models.test.ts`
Expected: FAIL with missing model/preprocessing exports.

- [ ] **Step 3: 实现公共模型接口和预处理**

```ts
export type GrayPatch = { width: number; height: number; data: Float32Array };
export type FeatureResult = { x: number; y: number; residual: number; confidence: number; metrics: Record<string, number> };
export interface FeatureModel { readonly type: "circle" | "blob" | "crosshair" | "diagonal" | "speckle"; detectInitial(patch: GrayPatch): FeatureResult; refineSubpixel(patch: GrayPatch, initial?: FeatureResult): FeatureResult; }
```

Implement `toGrayscale`, `subtractLocalBackground`, `normalizePatch`, and `makeCirclePatch` with finite-value checks. Implement the circle/blob model using weighted moments plus a radial least-squares correction; implement crosshair/diagonal using two directional weighted centroids and line intersection; implement speckle using normalized cross-correlation against the stored template and a 3x3 correlation-peak quadratic fit. Keep each model as a pure function with no DOM dependency.

- [ ] **Step 4: 运行单元与精度测试**

Run: `pnpm --filter @subpixel/algorithms test -- --run`
Expected: preprocessing tests PASS; all synthetic center errors <= 0.1 px; invalid/empty patches return a structured error instead of NaN.

- [ ] **Step 5: Commit**

Run: `git add packages/algorithms; git commit -m "feat: add subpixel feature models"`

### Task 3: 实现预测、校正、质量门控和 Worker 协议

**Files:**
- Modify: `packages/algorithms/src/types.ts`
- Create: `packages/algorithms/src/tracker.ts`
- Create: `apps/web/src/workers/tracker.worker.ts`
- Create: `apps/web/src/workers/tracker.worker.test.ts`

- [ ] **Step 1: 写状态机失败测试**

```ts
it("marks a frame suspect when residual and displacement exceed thresholds", () => {
  const tracker = createTracker({ model: circleModel, roi, maxJumpPx: 4, maxResidual: 0.2, lostAfter: 2 });
  tracker.initialize(frame0);
  const result = tracker.process(frameWithJump);
  expect(result.state).toBe("suspect");
  expect(tracker.process(frameWithJump).state).toBe("lost");
});
```

- [ ] **Step 2: 运行失败测试**

Run: `pnpm --filter @subpixel/web test -- tracker.worker.test.ts`
Expected: FAIL because `createTracker` and Worker message handlers are absent.

- [ ] **Step 3: 实现 tracker API**

Implement `TrackerState` with `lastResult`, `velocity`, `template`, `consecutiveFailures`, `frame`, and thresholds. `initialize(frame)` calls the selected model on the ROI. `process(frame)` predicts `last + velocity`, extracts a bounded patch, refines it, calculates displacement/residual/confidence, updates velocity only for `valid`/`reviewed`, and emits `lost` after `lostAfter` consecutive failures. Return `{ track: PointTrack, event?: TrackingEvent }`.

- [ ] **Step 4: 实现 Worker 命令协议**

Use messages `{ type: "initialize", job, frame }`, `{ type: "process", frame, timestampMs }`, `{ type: "reset", roi }`, and `{ type: "dispose" }`; respond with `{ type: "initialized", track }`, `{ type: "track", track, event }`, or `{ type: "error", code, message, recoverable }`. Transfer `Float32Array` buffers instead of cloning them.

- [ ] **Step 5: 运行 Worker 和 tracker 测试**

Run: `pnpm --filter @subpixel/algorithms test -- --run; pnpm --filter @subpixel/web test -- tracker.worker.test.ts`
Expected: state transitions PASS; no Worker test leaves an open handle.

- [ ] **Step 6: Commit**

Run: `git add packages/algorithms apps/web/src/workers; git commit -m "feat: add worker-based tracking state machine"`

### Task 4: 接入文件/相机输入与首帧 ROI 工作流

**Files:**
- Create: `apps/web/src/features/capture/CaptureAdapter.ts`
- Create: `apps/web/src/features/capture/fileSource.ts`
- Create: `apps/web/src/features/capture/cameraSource.ts`
- Create: `apps/web/src/features/roi/RoiCanvas.tsx`
- Create: `apps/web/src/features/roi/modelRecommendation.ts`
- Create: `apps/web/src/features/roi/roi.test.ts`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: 写输入和 ROI 失败测试**

```ts
it("clamps ROI to image bounds while preserving a positive size", () => {
  expect(clampRoi({ x: -5, y: 90, width: 30, height: 30 }, { width: 100, height: 100 }))
    .toEqual({ x: 0, y: 90, width: 30, height: 10 });
});

it("recommends circle for a radially symmetric bright patch", () => {
  expect(recommendModel(makeCirclePatch({ center: { x: 8, y: 8 }, radius: 3 })).type).toBe("circle");
});
```

- [ ] **Step 2: 实现 CaptureAdapter**

Define `FrameSource` as an async iterator of `{ width, height, timestampMs, pixels }`. Implement image sequence/video decoding through `createImageBitmap` and canvas; implement camera source through `navigator.mediaDevices.getUserMedia({ video: true })`, with stop/reconnect methods and capability errors mapped to `input.permission` or `input.unsupported`.

- [ ] **Step 3: 实现 ROI 画布与模型推荐**

Render the source frame and a fixed-size zoom patch on `<canvas>`. Pointer drag creates a ROI, keyboard arrows nudge it by one pixel, and handles resize it within image bounds. Calculate brightness, edge density, radial symmetry, directional energy, and texture variance; return ranked model candidates with scores. Locking a model disables automatic switching.

- [ ] **Step 4: 组装首帧流程并运行组件测试**

Add states `empty -> source-ready -> roi-selected -> initialized -> tracking -> review`. Expose clear recovery actions for invalid files, camera permission denial, empty ROI, and no model candidate. Run: `pnpm --filter @subpixel/web test -- roi.test.ts` and `pnpm --filter @subpixel/web typecheck`; Expected: PASS with no canvas dimension shifts.

- [ ] **Step 5: Commit**

Run: `git add apps/web/src/features/capture apps/web/src/features/roi apps/web/src/App.tsx; git commit -m "feat: add capture adapters and ROI initialization"`

### Task 5: 构建任务工作台与实时质量审阅 UI

**Files:**
- Create: `apps/web/src/features/tracking/TrackingWorkbench.tsx`
- Create: `apps/web/src/features/tracking/MetricStrip.tsx`
- Create: `apps/web/src/features/tracking/EventTimeline.tsx`
- Create: `apps/web/src/features/tracking/TrackTable.tsx`
- Create: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/features/tracking/workbench.test.tsx`

- [ ] **Step 1: 写工作台行为测试**

Test that starting tracking disables model edits, a `suspect` row is highlighted and offers “复核此帧”, and a `lost` event offers “重新框选” and “回退到最近可靠帧”.

- [ ] **Step 2: 实现状态与 Worker 连接**

Create a reducer with actions `SOURCE_READY`, `ROI_CHANGED`, `INITIALIZED`, `TRACK_RECEIVED`, `EVENT_RECEIVED`, `REVIEW_FRAME`, `RESET_ROI`, and `STOP`. Subscribe to Worker responses and append tracks/events without blocking React rendering.

- [ ] **Step 3: 实现响应式工作台**

Use a desktop three-column grid (`minmax(220px, 280px) 1fr minmax(280px, 360px)`) and a tablet breakpoint that collapses sidebars into drawers. Show the main canvas, zoom patch, coordinates, confidence, residual, FPS, P95 latency, drop count, and state badge. Use icon buttons with tooltips for start/stop, reset, export, and camera reconnect.

- [ ] **Step 4: 运行组件和可访问性检查**

Run: `pnpm --filter @subpixel/web test -- workbench.test.tsx; pnpm --filter @subpixel/web typecheck`
Expected: PASS; keyboard focus order is source -> ROI controls -> start/stop -> table review; all icon-only buttons have accessible names.

- [ ] **Step 5: Commit**

Run: `git add apps/web/src/features/tracking apps/web/src/styles apps/web/src/App.tsx; git commit -m "feat: add responsive tracking workbench"`

### Task 6: 实现 FastAPI 精算接口与 Python 算法适配

**Files:**
- Modify: `services/api/pyproject.toml`
- Create: `services/api/app/schemas.py`
- Create: `services/api/app/jobs.py`
- Create: `services/api/app/algorithms.py`
- Modify: `services/api/app/main.py`
- Create: `services/api/tests/test_schemas.py`
- Create: `services/api/tests/test_algorithms.py`
- Create: `services/api/tests/test_jobs.py`

- [ ] **Step 1: 写后端失败测试**

Test `POST /api/jobs` accepts a `TrackingJob`, returns `202` with `jobId`, `GET /api/jobs/{id}` reports `queued/running/completed/failed`, and synthetic circle fitting returns center error <= 0.1 px.

- [ ] **Step 2: 实现 Pydantic schema 与路由**

Mirror the TypeScript fields exactly. Add `POST /api/jobs`, `GET /api/jobs/{job_id}`, `GET /api/jobs/{job_id}/tracks`, and `POST /api/jobs/{job_id}/cancel`. Use an in-memory task registry for the prototype, `asyncio.to_thread` for CPU work, and structured errors `{ code, message, recoverable, jobId }`.

- [ ] **Step 3: 实现 OpenCV 精算模型**

Implement grayscale/background normalization, circle/blob moment + `cv2.fitEllipse`, line intersection via robust least squares, and speckle template matching with `cv2.matchTemplate` plus quadratic peak refinement. Return the same JSON fields as `PointTrack`; reject non-finite values before serialization.

- [ ] **Step 4: 运行后端测试**

Run: `python -m pytest services/api/tests -q`
Expected: all schema, route, failure-recovery, and synthetic precision tests PASS.

- [ ] **Step 5: Commit**

Run: `git add services/api; git commit -m "feat: add FastAPI precision processing"`

### Task 7: 实现统一导出与报告生成

**Files:**
- Create: `packages/contracts/src/report.ts`
- Create: `apps/web/src/features/report/exportClient.ts`
- Create: `apps/web/src/features/report/ReportPanel.tsx`
- Create: `services/api/app/reports.py`
- Create: `services/api/tests/test_reports.py`
- Create: `apps/web/src/features/report/export.test.ts`

- [ ] **Step 1: 写导出失败测试**

Assert CSV/JSON preserve frame order and status, XLSX has `tracks` and `events` sheets, PDF manifest includes algorithm version/parameters/summary, and an export with no tracks returns a recoverable `export.empty` error.

- [ ] **Step 2: 实现浏览器导出**

Use Blob streams for CSV/JSON, `xlsx` for workbook generation, and a browser PDF renderer for summary/plots. Render marked images and video from the same track overlay renderer used by the live canvas, preserving frame dimensions.

- [ ] **Step 3: 实现后端报告接口**

Add `POST /api/jobs/{job_id}/reports` with requested formats and `GET /api/jobs/{job_id}/reports/{report_id}`. Generate XLSX with openpyxl, PDF with ReportLab, and PNG/JPEG overlays with OpenCV. Store a `ReportManifest` and return asset paths.

- [ ] **Step 4: 运行导出测试**

Run: `pnpm --filter @subpixel/web test -- export.test.ts; python -m pytest services/api/tests/test_reports.py -q`
Expected: all files open successfully; manifest fields and asset paths validate against `ReportManifestSchema`.

- [ ] **Step 5: Commit**

Run: `git add packages/contracts/src/report.ts apps/web/src/features/report services/api/app/reports.py services/api/tests/test_reports.py; git commit -m "feat: add tracking exports and reports"`

### Task 8: 完成端到端、性能和浏览器兼容验收

**Files:**
- Create: `apps/web/e2e/fixtures/synthetic-sequence.ts`
- Create: `apps/web/e2e/tracking.spec.ts`
- Create: `apps/web/e2e/export.spec.ts`
- Create: `apps/web/playwright.config.ts`
- Create: `scripts/benchmark-local.ts`
- Create: `services/api/tests/test_performance.py`

- [ ] **Step 1: 创建确定性合成输入**

Generate 300 frames containing a circle with known subpixel trajectory, noise, blur, brightness drift, and two occlusion windows. Generate a fake camera stream by replaying the same frames at 30 FPS.

- [ ] **Step 2: 写端到端场景**

Cover upload -> ROI drag -> model recommendation -> start -> suspect frame review -> lost -> reset ROI -> completed -> CSV/XLSX/PDF download. Assert final valid-frame ratio, RMS error <= 0.1 px, and event timeline contains initialization and recovery events.

- [ ] **Step 3: 运行性能基准**

Run: `pnpm tsx scripts/benchmark-local.ts --frames 300 --fps 30; python -m pytest services/api/tests/test_performance.py -q`
Expected: local offline path >= 30 FPS; camera simulation P95 end-to-end latency <= 150 ms; UI remains responsive while Worker processes frames.

- [ ] **Step 4: 运行跨浏览器 Playwright**

Run: `pnpm playwright test --project=chromium --project=webkit`
Expected: all workflows PASS in the latest Chromium/WebKit profiles at desktop and tablet viewports; no console errors or unhandled promise rejections.

- [ ] **Step 5: Commit**

Run: `git add apps/web/e2e apps/web/playwright.config.ts scripts services/api/tests/test_performance.py; git commit -m "test: verify tracking workflow and performance targets"`

## Self-review checklist

- Spec coverage: input adapters and首帧 ROI are covered by Task 4; all five feature types and quality gates by Tasks 2-3; local/server parity by Tasks 1, 3, and 6; responsive UI by Task 5; all requested exports by Task 7; metrics and browser acceptance by Task 8.
- Placeholder scan: every step contains concrete files, commands, expected results, or explicit implementation details; every failure path names a code, action, or test.
- Type consistency: `TrackingJob`, `PointTrack`, `TrackingEvent`, and `ReportManifest` are defined once in `packages/contracts` and mirrored in `services/api/app/schemas.py`; Worker and FastAPI both use the same model enum values and state values.
- Repository caveat: the current directory has no `.git` metadata, so commit commands are included for execution after repository initialization but were not run while writing this plan.
