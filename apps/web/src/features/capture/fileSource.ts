import { CaptureError, type CapturedFrame, type FrameSource } from "./CaptureAdapter";

export async function loadFirstFileFrame(file: File): Promise<CapturedFrame> {
  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) throw new CaptureError("input.invalid", "请选择图片或视频文件。");
  if (file.type.startsWith("image/")) {
    const image = await createImageBitmap(file);
    return { width: image.width, height: image.height, timestampMs: 0, image };
  }
  const video = document.createElement("video"); video.muted = true; video.src = URL.createObjectURL(file);
  await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new CaptureError("input.invalid", "视频解码失败。")); });
  video.loop = true;
  await video.play();
  return { width: video.videoWidth, height: video.videoHeight, timestampMs: 0, image: video };
}

export function imageSequenceSource(files: File[]): FrameSource {
  let stopped = false;
  return { stop: () => { stopped = true; }, async *[Symbol.asyncIterator]() { for (const file of files) { if (stopped) return; yield await loadFirstFileFrame(file); } } };
}
