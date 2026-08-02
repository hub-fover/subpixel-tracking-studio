import type { EngineStatus } from "@subpixel/contracts";

type OpenCvGlobal = { Mat?: unknown; getBuildInformation?: () => string; [key: string]: unknown };
let loading: Promise<EngineStatus> | undefined;

export function opencvAssetUrl(basePath = import.meta.env.BASE_URL || "/") {
  return `${basePath.replace(/\/$/, "/")}opencv/opencv.js`;
}

export function loadOpenCv(): Promise<EngineStatus> {
  if (loading) return loading;
  loading = new Promise<EngineStatus>(resolve => {
    const existing = (globalThis as typeof globalThis & { cv?: OpenCvGlobal }).cv;
    const ready = (cv: OpenCvGlobal | undefined) => {
      const hasDescriptors = Boolean(cv?.SIFT || cv?.SIFT_create || cv?.ORB || cv?.ORB_create);
      resolve(cv?.Mat ? { opencv: "ready", version: cv.getBuildInformation?.().split("\n")[0], capabilities: { refinement: Boolean(cv.cornerSubPix || cv.fitEllipse || cv.fitEllipseAMS), registration: Boolean(cv.findHomography), descriptors: hasDescriptors } } : { opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } });
    };
    if (existing?.Mat) { ready(existing); return; }
    if (typeof document === "undefined") { resolve({ opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } }); return; }
    const script = document.createElement("script");
    script.async = true;
    script.src = opencvAssetUrl();
    const timeout = window.setTimeout(() => resolve({ opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } }), 12_000);
    script.onload = () => {
      const cv = (globalThis as typeof globalThis & { cv?: OpenCvGlobal }).cv;
      const onReady = () => { window.clearTimeout(timeout); ready((globalThis as typeof globalThis & { cv?: OpenCvGlobal }).cv); };
      if (cv && typeof cv.then === "function") void (cv.then as (callback: () => void) => unknown)(onReady);
      else onReady();
    };
    script.onerror = () => { window.clearTimeout(timeout); resolve({ opencv: "unavailable", capabilities: { refinement: false, registration: false, descriptors: false } }); };
    document.head.appendChild(script);
  });
  return loading;
}

export function resetOpenCvLoader() { loading = undefined; }
