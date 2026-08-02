export type CapturedFrame = { width: number; height: number; timestampMs: number; image: CanvasImageSource };
export interface FrameSource extends AsyncIterable<CapturedFrame> { stop(): void; }
export class CaptureError extends Error { constructor(public code: "input.permission" | "input.unsupported" | "input.invalid", message: string) { super(message); } }
