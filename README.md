# Subpixel Tracking Studio

原图 ROI 亚像素特征提取、多点跟踪与大角度场景配准工作台。

## 开发

```powershell
pnpm install
pnpm dev
```

前端默认地址：`http://127.0.0.1:4173/`

后端 API：

```powershell
cd services/api
..\..\work\task1-api-venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm build
```

算法和导出始终使用原图像素；`work/`、构建产物和本地依赖不会提交到仓库。
