import type { FrameRegistration } from "@subpixel/contracts";

export async function registerScene(reference: Blob, current: Blob, sourceSize: { width: number; height: number }, frame: number, signal?: AbortSignal): Promise<FrameRegistration> {
  const form = new FormData();
  form.append("reference", reference, "reference.png");
  form.append("current", current, "current.png");
  form.append("source_width", String(sourceSize.width));
  form.append("source_height", String(sourceSize.height));
  form.append("frame", String(frame));
  const response = await fetch("/api/scene-registration", { method: "POST", body: form, signal });
  if (!response.ok) throw new Error(`scene registration failed (${response.status})`);
  return await response.json() as FrameRegistration;
}
