# 手机端/网页端 ROI 收敛与视频跟踪修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让网页端和手机端在原图像素坐标下稳定完成 ROI 框选、精修、确认保存，并让视频逐帧跟踪和自然特征失锁提示可验证。

**Architecture:** ROI 精修使用首次框选时捕获的单帧原生快照，不再依赖实时相机帧；实时预览只负责显示。视频文件使用可 seek 的隐藏 video 元素按 15 FPS 产生原生尺寸帧，复用现有本地算法引擎。自然点先使用宽预测窗口 NCC，再在失败时报告严格门控失败，保留 pointId，不静默换绑。

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Playwright/浏览器手工验证, Canvas/SVG 原图坐标, ImageBitmap, 现有 `LocalAlgorithmEngine` 与 `MultiPointTracker`。

---

## 已确认根因与当前状态

1. `App.tsx` 的精修防抖依赖每帧变化的 `image` 和 `sourceSize` 对象。相机帧每约 33 ms 更新一次，150 ms 定时器被反复清理，因此侧边草稿长期是 `refining`，确认按钮不可用。网页端和手机端共用此代码，都会复现。
2. ROI 画布之前会因新 ImageBitmap 重置拖动状态；这部分已在远程提交 `2fe88268` 修复，当前 `RoiCanvas` 只在原生尺寸变化时重置拖动。
3. 当前工作区有未提交的自然角点候选改进，以及本轮尚未完成的精修快照改动。不要 reset 或覆盖这些用户已有修改。
4. `processFiles()` 每个输入文件只处理一次；视频文件因此只有首帧，没有逐帧跟踪。
5. `LocalAlgorithmEngine.track()` 对自然点仍主要使用 NCC，`forwardBackwardError` 为占位 0，`loweRatio` 由 NCC 伪造；需要明确失败状态和宽预测重定位路径。

## 文件分工

- `apps/web/src/App.tsx`: 草稿生命周期、精修快照、视频帧循环、跟踪状态和风险提示。
- `apps/web/src/features/roi/RoiCanvas.tsx`: 原图尺寸 Canvas、SVG 覆盖层、触摸/鼠标 ROI 交互。
- `apps/web/src/features/capture/fileSource.ts`: 图片首帧与视频元素加载，保证首帧暂停。
- `apps/web/src/features/local/localAlgorithmEngine.ts`: 预测窗口、NCC/描述子重定位和自然点门控指标。
- `apps/web/src/features/local/localRefinement.ts`: 合作标志与自然角点本地精修。
- `apps/web/src/features/roi/refinementClient.ts`: 仅保留兼容 API，不进入主流程。
- `apps/web/src/features/local/*.test.ts`, `apps/web/src/features/roi/*.test.ts`: 算法和 ROI 状态测试。
- `apps/web/src/App.test.tsx` 或现有 Web 测试目录: 组件层确认按钮、风险状态和多点保存测试；若当前没有组件测试，新增最小测试夹具。
- `docs/superpowers/plans/2026-08-02-mobile-roi-video-tracking.md`: 本计划。
- `.github/workflows/deploy-pages.yml`: 构建/发布后做静态资源和入口检查，不改变部署架构。

---

## Task 1: 固定 ROI 精修输入帧

**Files:** `apps/web/src/App.tsx`; `apps/web/src/features/roi/roi.test.ts` 或新增 `apps/web/src/appState.test.ts`。

- [ ] 保留当前 `refinementImageRef`、拥有权标志和 token 设计，补齐 `onSelectionChange`：第一次框选时把当前 `image` 复制为 `ImageBitmap`，草稿先置为 `selecting`；快照完成后仅在 token/id 仍匹配时切换为 `refining` 并递增 revision。ROI 调整只更新 ROI 和 revision，不重新复制帧。
- [ ] 精修 effect 只依赖 `draft.id/revision/roi`、原生宽高数值和快照版本，不依赖实时 `image` 或 `sourceSize` 对象引用；快照不存在时不启动请求。保留版本检查，过期 Worker 响应必须丢弃。
- [ ] 确认、删除、重新初始化、切换文件和组件卸载时释放拥有的 ImageBitmap；不关闭 `referenceFrameRef` 或当前显示帧。
- [ ] 只允许 `ready + refinement.accepted` 确认；失败显示具体 gate 原因，不能以 ROI 中心补成功。
- [ ] 添加测试：连续 10 次模拟 image/sourceSize 更新期间，精修 promise 仍完成；过期 revision 不改变当前 draft；确认后生成一个 seed，删除草稿不生成 seed。
- [ ] 运行 `pnpm --filter @subpixel/web test -- --runInBand`（Vitest 不支持该参数时运行 `pnpm --filter @subpixel/web test`），预期现有测试全部通过。

## Task 2: 修正视频文件首帧与逐帧处理

**Files:** `apps/web/src/features/capture/fileSource.ts`, `apps/web/src/features/capture/CaptureAdapter.ts`, `apps/web/src/App.tsx`, `apps/web/src/features/capture/cameraSource.test.ts`。

- [ ] 将视频加载返回值扩展为可选 `video`/`duration` 句柄，加载 metadata 后 seek 到 `0`、暂停；首帧用 `createImageBitmap(video)`，不让视频在 ROI 初始化期间自动播放。
- [ ] 在 `App.tsx` 保存所选视频句柄；开始跟踪时对视频按 `timestamp += 1000/15` seek，等待 `seeked`，用原生尺寸 `createImageBitmap(video)` 生成单帧，调用 `processFrame`，每 5 帧调用场景配准；上一帧 ImageBitmap 处理完立即 close。
- [ ] 图片序列继续按文件逐帧处理；视频结束、用户暂停或 tracker paused 时停止循环并保留最后结果，释放 object URL 和 video 资源。
- [ ] 若浏览器 seek 触发 error 或无法读到原生宽高，添加可恢复风险 `video.decode-failed`，不伪造轨迹。
- [ ] 测试：视频首帧返回时 `paused === true`；模拟 0、66.7、133.3 ms 三帧调用 `processFrame` 三次，输入宽高始终等于 `videoWidth/videoHeight`。

## Task 3: 自然特征跟踪严格门控

**Files:** `apps/web/src/features/local/localAlgorithmEngine.ts`, `packages/algorithms/src/multi-tracker.ts`, `packages/algorithms/src/natural-features.ts`, corresponding tests。

- [ ] 对自然点将预测窗口从固定 10 px 改为 `max(24, 2*templateSize, 3*registrationError + lastDisplacement)`，仍在原图坐标并夹紧 ROI。
- [ ] 在 NCC 低于 `0.70` 时尝试 ORB/SIFT descriptor relocation（OpenCV.js 可用时）；只接受与原始模板 descriptor 的 Lowe ratio `<= 0.75`，并保留候选的原 pointId。
- [ ] 计算正向/反向局部匹配误差；`>1.5 px`、NCC `<0.70`、极线误差 `>2 px` 或 Lowe ratio `>0.75` 时输出 `suspect/lost`，不得使用邻近点替代。
- [ ] 将真实指标写入 `MultiPointTrack`；删除 `forwardBackwardError: 0` 和 `loweRatio: 1 - ncc` 占位逻辑。OpenCV 不可用时返回明确的 `descriptor-unavailable` 风险并继续严格 NCC 门控。
- [ ] 测试：小位移自然点通过；大位移 descriptor relocation 通过且 pointId 不变；重复纹理、低 NCC、正反向误差超限都保持原 pointId 的 lost/suspect。

## Task 4: 网页/手机交互与侧栏验收

**Files:** `apps/web/src/features/roi/RoiCanvas.tsx`, `apps/web/src/features/tracking/TrackingWorkbench.tsx`, CSS, component tests。

- [ ] 保持 Canvas 内部宽高等于原图；触摸 `pointerdown/move/up` 继续使用 `setPointerCapture`，新增 `touch-action: none`，避免手机浏览器滚动/缩放取消 pointer 事件。
- [ ] 给草稿 ROI、八个手柄、中心十字丝、失败/成功几何添加稳定 `data-testid` 或 `data-point-id`，便于检查。
- [ ] 侧栏明确显示 `selecting -> refining -> ready/invalid`；`ready` 时“确认点”立即可点，`invalid` 时显示 gate 和“重新框选 ROI”。
- [ ] 使用 Playwright/现有浏览器检查桌面和 390×844 手机 viewport：导入测试图、框选、等待 150 ms、确认；验证草稿消失、点列表为 1、画布有一个 `data-point-id`，控制台没有异常。
- [ ] 检查 25%/100%/800% 缩放与 resize 后 ROI 原图坐标不变。

## Task 5: 本地算法与报告回归

**Files:** `apps/web/src/features/local/localRefinement.test.ts`, `apps/web/src/features/report/export.test.ts`, `apps/web/src/features/tracking/pointSetState.test.ts`。

- [ ] 保留已修改的自然角点 NMS；补充 circle/crosshair/diagonal/corner 的空 ROI、触边、低对比和合成亚像素测试。
- [ ] 验证 3 点和 100 点确认后 `points` 完整，未跟踪导出 `tracks=[]` 但 points 不为空；跟踪导出每个 pointId 的逐帧记录。
- [ ] CSV/JSON/XLSX/PDF 统一使用 `pointId`，删除后 ID 不复用；风险提示和处理统计随 JSON 导出。
- [ ] 运行 `pnpm test`, `pnpm typecheck`, `pnpm build`。

## Task 6: Pages 发布与真实验收

**Files:** `.github/workflows/deploy-pages.yml`, `README.md`（若需要补充排障说明）。

- [ ] 提交前检查 `git diff`，只包含本修复和当前用户已有自然角点修改；不 reset、不覆盖远程等价 Pages 提交。
- [ ] 使用现有 GitHub Contents API/远程发布方式更新 `main` 和 Pages；普通 `git push` 若连接重置，不重复破坏性操作。
- [ ] 发布后检查：入口 HTTP 200、`opencv/opencv.js` HTTP 200、manifest HTTP 200、页面无 `/api` 请求、无 404 静态资源。
- [ ] 真机/移动浏览器验收：打开相机、框选 ROI、等待 `ready`、确认保存；拍摄视频、停止精算；自然点大位移失败时显示风险并保持 lost，不静默换绑。
- [ ] 记录未能在当前环境验证的项目：真实摄像头权限、Safari VideoFrame、OpenCV.js 低内存加载。

## 验收门槛

- 网页和手机同一 ROI 流程可在 150 ms 后进入 `ready`，确认按钮可用并产生 seed。
- 相机连续帧更新不影响草稿状态；确认后的点不丢失、不重复。
- 视频处理至少产生 3 个时间帧，且原生尺寸不变。
- 自然点门控失败只显示 suspect/lost 和风险动作，不静默改绑。
- `pnpm test`, `pnpm typecheck`, `pnpm build` 通过；Pages 入口和关键静态资源返回 200。

