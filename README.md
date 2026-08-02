# Subpixel Tracking Studio

原图 ROI 亚像素特征提取、多点跟踪与大角度场景配准工作台。

在线仓库：[github.com/hub-fover/subpixel-tracking-studio](https://github.com/hub-fover/subpixel-tracking-studio)

手机或桌面浏览器直接打开：[GitHub Pages 工作台](https://hub-fover.github.io/subpixel-tracking-studio/)

## 功能

- 基于原始图像像素的 ROI 框选、调整、确认和删除。
- 圆/椭圆、十字丝、对角标志、角点、光斑、散斑和自然关键点提取。
- 最多 100 个点的混合跟踪，使用稳定的 `pointId` 保存身份。
- SVG 矢量覆盖层：拟合轮廓、中心十字丝、编号、预测位置、轨迹和状态。
- SIFT/ORB + RANSAC 场景配准，支持旋转、缩放、透视和大角度相机变化。
- 失锁后参考帧/当前帧双画布锚点恢复，至少 4 个锚点并进行退化检查。
- JSON、CSV、XLSX、PDF、标注图片和标注视频导出。

所有算法、ROI、模板、跟踪和导出都使用原图坐标。视图缩放只改变显示，不生成算法工作缩略图。

## 快速开始

### 前端

需要 Node.js 20+、pnpm 10+。

```powershell
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:4173/>。

### 后端 API

需要 Python 3.11+ 和 OpenCV。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "services/api[dev]"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir services/api --host 127.0.0.1 --port 8001
```

健康检查：<http://127.0.0.1:8001/health>

### Codespaces

[一键打开 GitHub Codespace](https://github.com/codespaces/new?repo=hub-fover/subpixel-tracking-studio)

GitHub Pages 当前提供前端工作台预览。完整的原图精修和大角度场景配准需要同时部署 FastAPI 服务，并将前端构建变量 `VITE_API_BASE` 指向 API 地址。

## API

- `POST /api/features/refine`：原图 ROI 特征精修。
- `POST /api/scene-registration`：SIFT/ORB 场景配准和单应矩阵计算。
- `POST /api/multi-jobs`：创建多点任务。
- `GET /api/multi-jobs/{id}/tracks`：读取逐点逐帧轨迹。
- `POST /api/multi-jobs/{id}/recovery/anchors`：提交恢复锚点。
- `POST /api/multi-jobs/{id}/recovery/apply`：应用恢复变换。
- `POST /api/multi-jobs/{id}/recovery/rollback`：回退恢复。

## 项目结构

```text
apps/web/                 React + Vite 工作台
packages/contracts/       前后端共享 Zod 合同
packages/algorithms/      多点跟踪、局部仿射和自然特征算法
services/api/             FastAPI + OpenCV 后端
scripts/                  基准测试和样本评估脚本
docs/                     设计规格和实施计划
```

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm build
work\task1-api-venv\Scripts\python.exe -m pytest services\api\tests -q
pnpm --filter @subpixel/web exec playwright test
```

真实图像素材和生成结果放在本地 `work/`，不会提交到仓库。
