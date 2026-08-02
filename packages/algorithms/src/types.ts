export type GrayPatch = { width: number; height: number; data: Float32Array };
export type FeatureType = "circle" | "blob" | "crosshair" | "diagonal" | "speckle" | "natural-keypoint";
export type FeatureResult = {
  x: number;
  y: number;
  residual: number;
  confidence: number;
  metrics: Record<string, number>;
};
export interface FeatureModel {
  readonly type: FeatureType;
  detectInitial(patch: GrayPatch): FeatureResult;
  refineSubpixel(patch: GrayPatch, initial?: FeatureResult): FeatureResult;
}
