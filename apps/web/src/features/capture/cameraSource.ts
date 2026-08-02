import { CaptureError, type FrameSource } from "./CaptureAdapter";

export async function cameraSource(video: HTMLVideoElement): Promise<FrameSource> {
  if (!navigator.mediaDevices?.getUserMedia) throw new CaptureError("input.unsupported", "此浏览器不支持相机采集。");
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
  catch { throw new CaptureError("input.permission", "相机权限未授权，请检查浏览器设置。"); }
  video.srcObject = stream; video.muted = true; await video.play(); let stopped = false;
  return { stop() { stopped = true; stream.getTracks().forEach(track => track.stop()); }, async *[Symbol.asyncIterator]() { while (!stopped) { yield { width: video.videoWidth, height: video.videoHeight, timestampMs: performance.now(), image: video }; await new Promise(requestAnimationFrame); } } };
}
