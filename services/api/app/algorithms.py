from time import perf_counter

import cv2
import numpy as np

from .schemas import FeatureType, PointTrack


def detect_natural_candidates(image: np.ndarray, limit: int = 100) -> list[dict[str, float]]:
    """Recommend Shi-Tomasi points with a deterministic quality score."""
    gray = image if image.ndim == 2 else cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    corners = cv2.goodFeaturesToTrack(gray.astype(np.uint8), maxCorners=limit * 2, qualityLevel=0.01, minDistance=8, blockSize=5, useHarrisDetector=False)
    if corners is None:
        return []
    height, width = gray.shape[:2]
    result: list[dict[str, float]] = []
    for corner in corners.reshape(-1, 2):
        x, y = map(float, corner)
        patch = gray[max(0, int(y) - 4):min(height, int(y) + 5), max(0, int(x) - 4):min(width, int(x) + 5)].astype(np.float32)
        entropy = float(min(1.0, patch.std() / 80.0))
        boundary = float(min(x, y, width - 1 - x, height - 1 - y) / max(1.0, min(width, height) / 2))
        score = float(np.clip(.55 * entropy + .35 * boundary + .1, 0, 1))
        result.append({"x": x, "y": y, "score": score, "textureEntropy": entropy, "boundaryDistance": boundary})
    return sorted(result, key=lambda item: item["score"], reverse=True)[:limit]


def register_scene_sift(reference: np.ndarray, current: np.ndarray) -> dict[str, float | int | str]:
    ref_gray = reference if reference.ndim == 2 else cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY)
    cur_gray = current if current.ndim == 2 else cv2.cvtColor(current, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create(nfeatures=2000)
    key_ref, desc_ref = sift.detectAndCompute(ref_gray, None)
    key_cur, desc_cur = sift.detectAndCompute(cur_gray, None)
    if desc_ref is None or desc_cur is None or len(key_ref) < 4 or len(key_cur) < 4:
        return {"method": "sift-ransac", "matchCount": 0, "inlierCount": 0, "inlierRatio": 0.0, "medianReprojectionError": float("inf")}
    matches = cv2.BFMatcher().knnMatch(desc_ref, desc_cur, k=2)
    good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance <= .75 * pair[1].distance]
    if len(good) < 4:
        return {"method": "sift-ransac", "matchCount": len(good), "inlierCount": 0, "inlierRatio": 0.0, "medianReprojectionError": float("inf")}
    points_ref = np.float32([key_ref[m.queryIdx].pt for m in good])
    points_cur = np.float32([key_cur[m.trainIdx].pt for m in good])
    _, mask = cv2.findFundamentalMat(points_ref, points_cur, cv2.FM_RANSAC, 2.0, .99)
    inliers = mask.ravel().astype(bool) if mask is not None else np.zeros(len(good), dtype=bool)
    errors = np.linalg.norm(points_ref[inliers] - points_cur[inliers], axis=1) if inliers.any() else np.array([float("inf")])
    return {"method": "sift-ransac", "matchCount": len(good), "inlierCount": int(inliers.sum()), "inlierRatio": float(inliers.mean()) if len(inliers) else 0.0, "medianReprojectionError": float(np.median(errors))}


def validate_natural_identity(forward_backward_error: float, ncc: float, epipolar_error: float, lowe_ratio: float) -> dict[str, bool | str]:
    gates = [(forward_backward_error <= 1.5, "forward/backward flow"), (ncc >= .70, "NCC"), (epipolar_error <= 2, "epipolar"), (lowe_ratio <= .75, "Lowe ratio")]
    failed = next(((label) for accepted, label in gates if not accepted), None)
    return {"accepted": failed is None, "reason": failed or ""}


def normalize_patch(patch: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY) if patch.ndim == 3 else patch.astype(np.float32)
    gray = gray.astype(np.float32)
    return (gray - float(gray.mean())) / max(float(gray.std()), 1e-6)


def fit_weighted_center(patch: np.ndarray, model: FeatureType = FeatureType.blob, frame: int = 0, timestamp_ms: float = 0) -> PointTrack:
    started = perf_counter()
    normalized = normalize_patch(patch)
    weights = np.maximum(normalized, 0)
    mass = float(weights.sum())
    if mass <= 1e-8:
        raise ValueError("algorithm.no-candidate")
    yy, xx = np.indices(weights.shape)
    x = float((xx * weights).sum() / mass)
    y = float((yy * weights).sum() / mass)
    radius = np.hypot(xx - x, yy - y)
    radial_mean = float((radius * weights).sum() / mass)
    residual = float(np.sqrt((((radius - radial_mean) ** 2) * weights).sum() / mass) / max(radial_mean, 1))
    confidence = max(0.0, min(1.0, 1 - residual))
    return PointTrack(frame=frame, timestampMs=timestamp_ms, x=x, y=y, model=model, residual=residual, confidence=confidence, state="valid" if confidence >= 0.35 else "suspect", durationMs=(perf_counter() - started) * 1000)


def fit_speckle(template: np.ndarray, patch: np.ndarray, frame: int = 0, timestamp_ms: float = 0) -> PointTrack:
    started = perf_counter()
    result = cv2.matchTemplate(normalize_patch(patch), normalize_patch(template), cv2.TM_CCOEFF_NORMED)
    _, maximum, _, location = cv2.minMaxLoc(result)
    x = float(location[0] + template.shape[1] / 2)
    y = float(location[1] + template.shape[0] / 2)
    return PointTrack(frame=frame, timestampMs=timestamp_ms, x=x, y=y, model=FeatureType.speckle, residual=max(0, 1 - maximum), confidence=max(0, min(1, maximum)), state="valid" if maximum >= 0.35 else "suspect", durationMs=(perf_counter() - started) * 1000)
