"""Original-pixel scene registration for large camera motion."""

from __future__ import annotations

import time
from typing import Any

import cv2
import numpy as np


def _result(*, frame: int, method: str, match_count: int, inlier_count: int,
            median_error: float, latency_ms: float, matrix: np.ndarray | None,
            accepted: bool, reason: str | None) -> dict[str, Any]:
    ratio = inlier_count / match_count if match_count else 0.0
    return {
        "frame": frame,
        "method": method,
        "matchCount": int(match_count),
        "inlierCount": int(inlier_count),
        "inlierRatio": float(ratio),
        "medianReprojectionError": float(median_error),
        "p95LatencyMs": float(latency_ms),
        "transform": {"kind": "homography", "matrix": matrix.reshape(-1).astype(float).tolist()} if matrix is not None else None,
        "accepted": bool(accepted),
        "reason": reason,
    }


def register_scene(reference: np.ndarray, current: np.ndarray, frame: int = 0) -> dict[str, Any]:
    """Estimate reference->current homography without resampling either input."""
    started = time.perf_counter()
    ref = cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY) if reference.ndim == 3 else reference
    cur = cv2.cvtColor(current, cv2.COLOR_BGR2GRAY) if current.ndim == 3 else current
    attempts: list[tuple[str, Any, int, float]] = []
    if hasattr(cv2, "SIFT_create"):
        attempts.append(("sift-ransac", cv2.SIFT_create(nfeatures=6000), cv2.NORM_L2, 0.75))
    attempts.append(("orb-ransac", cv2.ORB_create(nfeatures=6000, fastThreshold=5), cv2.NORM_HAMMING, 0.8))
    method = attempts[-1][0]
    keypoints_ref = keypoints_cur = []
    good: list[Any] = []
    src = dst = None
    for candidate_method, detector, norm, ratio in attempts:
        kp_ref, desc_ref = detector.detectAndCompute(ref, None)
        kp_cur, desc_cur = detector.detectAndCompute(cur, None)
        if desc_ref is None or desc_cur is None:
            continue
        pairs = cv2.BFMatcher(norm).knnMatch(desc_ref, desc_cur, k=2)
        candidate_good = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance <= ratio * pair[1].distance]
        if len(candidate_good) < 4:
            continue
        method = candidate_method
        keypoints_ref, keypoints_cur, good = kp_ref, kp_cur, candidate_good
        src = np.float32([keypoints_ref[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([keypoints_cur[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        break
    if src is None or dst is None:
        return _result(frame=frame, method=method, match_count=0, inlier_count=0, median_error=0.0,
                       latency_ms=(time.perf_counter() - started) * 1000, matrix=None,
                       accepted=False, reason="insufficient-matches")
    matrix, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0, maxIters=3000, confidence=0.995)
    if matrix is None or mask is None:
        return _result(frame=frame, method=method, match_count=len(good), inlier_count=0, median_error=0.0,
                       latency_ms=(time.perf_counter() - started) * 1000, matrix=None,
                       accepted=False, reason="insufficient-inliers")
    projected = cv2.perspectiveTransform(src, matrix)
    errors = np.linalg.norm(projected[:, 0] - dst[:, 0], axis=1)
    inliers = mask.ravel().astype(bool)
    inlier_errors = errors[inliers]
    inlier_count = int(inliers.sum())
    median = float(np.median(inlier_errors)) if inlier_count else float(np.median(errors))
    match_count = len(good)
    accepted = match_count >= 50 and inlier_count / max(match_count, 1) >= 0.35 and median <= 3.0
    reason = None if accepted else (
        "insufficient-matches" if match_count < 50 else
        "low-inlier-ratio" if inlier_count / max(match_count, 1) < 0.35 else
        "high-reprojection-error"
    )
    return _result(frame=frame, method=method, match_count=match_count, inlier_count=inlier_count,
                   median_error=median, latency_ms=(time.perf_counter() - started) * 1000,
                   matrix=matrix, accepted=accepted, reason=reason)
