# Subpixel Tracking Studio

原图 ROI 亚像素特征提取、多点跟踪与移动端相机工作台。

手机端直接打开：<https://hub-fover.github.io/subpixel-tracking-studio/>

## 手机端能力

- 点击“打开相机”后使用后置摄像头，支持前后摄像头切换和录制。
- 相机、图片、视频均在浏览器本地处理，不上传原始图像，也不请求 FastAPI。
- 算法输入保持相机或原图的原生像素尺寸；25%–800% 缩放只改变显示。
- 支持圆/椭圆、十字丝、对角标志、角点、光斑、散斑和自然关键点。
- 支持多点确认、逐点状态、失锁风险提示、锚点恢复和 JSON/CSV/XLSX/PDF/图片/视频导出。
- OpenCV.js 随 Pages 自托管并按需加载；加载失败时保留 TypeScript 小位移路径，并明确提示大角度自然点能力不可用。

### 手机使用条件

- 必须使用 HTTPS 地址并在浏览器中点击“打开相机”授予权限。
- 首版重点验证 Android Chrome 和 iPhone Safari；微信内置浏览器不作为保证环境。
- 浏览器不支持相机、录制、WebAssembly 或 OpenCV.js 时，页面会显示具体风险和可执行动作，不会静默使用 ROI 中心或换绑邻近点。
- OpenCV.js 首次加载约 10 MB；低内存或弱性能设备可能自动降帧并退回 TypeScript 小位移路径，大角度自然点重定位会提示不可用。
- 设备电量低、屏幕方向变化、权限拒绝、ROI 门控失败和失锁都会显示原因与下一步动作；风险不会被静默忽略。

## 本地开发

需要 Node.js 20+、pnpm 10+：

```powershell
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:4173/>。本地相机调试需要 HTTPS 或浏览器允许的 localhost 安全上下文。

## 可选 FastAPI 服务

FastAPI 仅保留给桌面端或回归测试使用，手机 Pages 主流程不依赖它：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "services/api[dev]"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8001
```

## GitHub Pages

Actions 构建 `apps/web`，复制自托管 OpenCV.js，并发布到 `gh-pages` 分支。仓库 Pages 源配置为 `gh-pages` / `/ (root)`。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @subpixel/web exec playwright test
```

真实图像和评估结果放在本地 `work/`，不会提交原始素材。
