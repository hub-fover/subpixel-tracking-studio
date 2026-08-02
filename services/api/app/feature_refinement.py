from enum import Enum
from math import atan2, degrees, pi

import cv2
import numpy as np
from pydantic import BaseModel


class ExtractionIntent(str, Enum):
    circle_center = "circle-center"
    crosshair_center = "crosshair-center"
    diagonal_center = "diagonal-center"
    corner = "corner"
    blob_center = "blob-center"
    speckle_center = "speckle-center"
    natural_keypoint = "natural-keypoint"


class RefinedPoint(BaseModel):
    x: float
    y: float


class RefinementGeometry(BaseModel):
    kind: str
    center: RefinedPoint | None = None
    point: RefinedPoint | None = None
    majorAxis: float | None = None
    minorAxis: float | None = None
    angleDeg: float | None = None
    edgeCoverage: float | None = None
    inlierCount: int | None = None
    line1: dict | None = None
    line2: dict | None = None
    support1: float | None = None
    support2: float | None = None
    widthCv: float | None = None
    response: float | None = None
    uniquenessRatio: float | None = None


class FeatureRefinement(BaseModel):
    accepted: bool
    intent: ExtractionIntent
    roi: dict[str, float]
    point: RefinedPoint | None
    confidence: float
    residualPx: float | None
    gates: dict[str, bool]
    reason: str | None
    geometry: RefinementGeometry | None


def _result(intent: ExtractionIntent, roi: tuple[float, float, float, float], *, point=None,
            confidence=0.0, residual=None, gates=None, reason=None, geometry=None) -> FeatureRefinement:
    return FeatureRefinement(accepted=point is not None and all((gates or {}).values()), intent=intent,
                             roi={"x": roi[0], "y": roi[1], "width": roi[2], "height": roi[3]},
                             point=point, confidence=float(np.clip(confidence, 0, 1)), residualPx=residual,
                             gates=gates or {}, reason=reason, geometry=geometry)


def _gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return np.asarray(image, dtype=np.uint8)


def _global(point: tuple[float, float], roi: tuple[float, float, float, float]) -> RefinedPoint:
    return RefinedPoint(x=float(point[0] + roi[0]), y=float(point[1] + roi[1]))


def _ellipse(image: np.ndarray, intent: ExtractionIntent, roi: tuple[float, float, float, float]) -> FeatureRefinement:
    blurred = cv2.GaussianBlur(image, (3, 3), 0.7)
    low, high = float(blurred.min()), float(blurred.max())
    if high - low < 8:
        return _result(intent, roi, gates={"contrast": False}, reason="refinement.low-contrast")
    edges = cv2.Canny(blurred, max(5, int(low + .2 * (high - low))), max(15, int(low + .6 * (high - low))))
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    height, width = image.shape
    candidates = []
    for contour in contours:
        if len(contour) < 32:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        touches = x <= 1 or y <= 1 or x + w >= width - 1 or y + h >= height - 1
        if touches or w < 6 or h < 6:
            continue
        ellipse = cv2.fitEllipseAMS(contour)
        (cx, cy), (axis_a, axis_b), angle = ellipse
        major, minor = max(axis_a, axis_b), min(axis_a, axis_b)
        if minor <= 0:
            continue
        perimeter = pi * (3 * (major + minor) - np.sqrt((3 * major + minor) * (major + 3 * minor))) / 2
        coverage = min(1.0, cv2.arcLength(contour, True) / max(perimeter, 1))
        points = contour.reshape(-1, 2).astype(np.float64)
        theta = np.deg2rad(angle)
        cos_t, sin_t = np.cos(theta), np.sin(theta)
        dx, dy = points[:, 0] - cx, points[:, 1] - cy
        ex = dx * cos_t + dy * sin_t
        ey = -dx * sin_t + dy * cos_t
        radial = np.sqrt((ex / max(axis_a / 2, 1e-6)) ** 2 + (ey / max(axis_b / 2, 1e-6)) ** 2)
        residual = float(np.median(np.abs(radial - 1)) * minor / 2)
        score = coverage - residual / max(minor, 1) - np.hypot(cx - width / 2, cy - height / 2) / max(width, height)
        candidates.append((score, cx, cy, major, minor, angle, coverage, residual, len(contour)))
    if not candidates:
        return _result(intent, roi, gates={"completeGeometry": False}, reason="refinement.incomplete-geometry")
    _, cx, cy, major, minor, angle, coverage, residual, count = max(candidates, key=lambda item: item[0])
    limit = max(.75, .02 * minor)
    gates = {"completeGeometry": True, "edgePoints": count >= 32, "edgeCoverage": coverage >= .60,
             "axisRatio": minor / major >= .15, "residual": residual <= limit,
             "insideRoi": 2 < cx < width - 2 and 2 < cy < height - 2}
    center = _global((cx, cy), roi)
    geometry = RefinementGeometry(kind="ellipse", center=center, majorAxis=major, minorAxis=minor,
                                  angleDeg=angle, edgeCoverage=coverage, inlierCount=count)
    return _result(intent, roi, point=center if all(gates.values()) else None,
                   confidence=min(1, coverage * max(0, 1 - residual / max(limit, 1e-6))), residual=residual,
                   gates=gates, reason=None if all(gates.values()) else "refinement.quality-gate", geometry=geometry)


def _angle_distance(a: float, b: float) -> float:
    value = abs(a - b) % pi
    return min(value, pi - value)


def _line_endpoints(normal: np.ndarray, distance: float, shape: tuple[int, int], origin: tuple[float, float]) -> dict:
    height, width = shape
    center = np.array([width / 2, height / 2], dtype=float) + normal * distance
    direction = np.array([-normal[1], normal[0]])
    span = float(np.hypot(width, height))
    start, end = center - direction * span, center + direction * span
    return {"start": {"x": float(start[0] + origin[0]), "y": float(start[1] + origin[1])},
            "end": {"x": float(end[0] + origin[0]), "y": float(end[1] + origin[1])}}


def _lines(image: np.ndarray, intent: ExtractionIntent, roi: tuple[float, float, float, float]) -> FeatureRefinement:
    blurred = cv2.GaussianBlur(image, (3, 3), .6)
    if float(blurred.max() - blurred.min()) < 8:
        return _result(intent, roi, gates={"contrast": False}, reason="refinement.low-contrast")
    edges = cv2.Canny(blurred, 30, 100)
    threshold = max(12, min(image.shape) // 4)
    raw = cv2.HoughLines(edges, 1, np.pi / 720, threshold)
    if raw is None or len(raw) < 4:
        return _result(intent, roi, gates={"linePairs": False}, reason="refinement.missing-lines")
    values = np.array([[rho, theta] for rho, theta in raw[:80, 0]], dtype=np.float64)
    features = np.column_stack((np.cos(2 * values[:, 1]), np.sin(2 * values[:, 1]))).astype(np.float32)
    _, labels, centers = cv2.kmeans(features, 2, None,
                                    (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 1e-6),
                                    10, cv2.KMEANS_PP_CENTERS)
    line_models = []
    image_center = np.array([image.shape[1] / 2, image.shape[0] / 2], dtype=float)
    for cluster in range(2):
        cluster_values = values[labels.ravel() == cluster]
        vector = centers[cluster]
        normal_angle = .5 * atan2(float(vector[1]), float(vector[0]))
        if normal_angle < 0:
            normal_angle += pi
        if intent == ExtractionIntent.crosshair_center:
            nearest_axis = min((0.0, pi / 2, pi), key=lambda axis: abs(normal_angle - axis))
            if abs(normal_angle - nearest_axis) <= np.deg2rad(5):
                normal_angle = nearest_axis % pi
        normal = np.array([np.cos(normal_angle), np.sin(normal_angle)])
        distances = []
        for rho, theta in cluster_values:
            candidate_normal = np.array([np.cos(theta), np.sin(theta)])
            if np.dot(candidate_normal, normal) < 0:
                candidate_normal *= -1
                rho *= -1
            distances.append(rho - float(np.dot(image_center, candidate_normal)))
        distances = np.array(distances, dtype=np.float32).reshape(-1, 1)
        if len(distances) < 2:
            return _result(intent, roi, gates={"linePairs": False}, reason="refinement.missing-lines")
        _, edge_labels, edge_centers = cv2.kmeans(distances, 2, None,
                                                  (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-5),
                                                  10, cv2.KMEANS_PP_CENTERS)
        edge_centers = np.sort(edge_centers.ravel())
        distance = float(edge_centers.mean())
        width = float(edge_centers[1] - edge_centers[0])
        yy, xx = np.indices(image.shape)
        bright = image.astype(np.float64) / 255
        signed = (xx - image_center[0]) * normal[0] + (yy - image_center[1]) * normal[1]
        selected = (np.abs(signed - distance) <= max(4, width * 1.5)) & (bright > .05)
        if np.count_nonzero(selected) >= 8:
            distance = float(np.average(signed[selected], weights=bright[selected]))
        signed_edges = (np.argwhere(edges > 0)[:, ::-1] - image_center) @ normal
        edge_errors = np.minimum(np.abs(signed_edges - (distance - width / 2)),
                                 np.abs(signed_edges - (distance + width / 2)))
        residual = float(np.median(edge_errors[edge_errors <= max(3, width)])) if np.any(edge_errors <= max(3, width)) else 99.0
        line_models.append((normal, distance, width, residual))
    normal1, distance1, width1, residual1 = line_models[0]
    normal2, distance2, width2, residual2 = line_models[1]
    matrix = np.vstack((normal1, normal2))
    rhs = np.array([np.dot(image_center, normal1) + distance1, np.dot(image_center, normal2) + distance2])
    if abs(np.linalg.det(matrix)) < 1e-4:
        return _result(intent, roi, gates={"angle": False}, reason="refinement.degenerate-lines")
    point = np.linalg.solve(matrix, rhs)
    angle = degrees(_angle_distance(atan2(-normal1[0], normal1[1]), atan2(-normal2[0], normal2[1])))
    if angle > 90:
        angle = 180 - angle
    width_cv = float(np.std([width1, width2]) / max(np.mean([width1, width2]), 1e-6))
    residual = max(residual1, residual2)
    gates = {"linePairs": True, "angle": 30 <= angle <= 90, "residual": residual <= .75,
             "widthConsistency": width_cv <= .35,
             "insideRoi": 0 <= point[0] < image.shape[1] and 0 <= point[1] < image.shape[0]}
    global_point = _global((float(point[0]), float(point[1])), roi)
    geometry = RefinementGeometry(kind="lines", line1=_line_endpoints(normal1, distance1, image.shape, (roi[0], roi[1])),
                                  line2=_line_endpoints(normal2, distance2, image.shape, (roi[0], roi[1])),
                                  angleDeg=angle, support1=1.0, support2=1.0, widthCv=width_cv)
    return _result(intent, roi, point=global_point if all(gates.values()) else None,
                   confidence=max(0, 1 - residual / .75) * max(0, 1 - width_cv / .35), residual=residual,
                   gates=gates, reason=None if all(gates.values()) else "refinement.quality-gate", geometry=geometry)


def _corner(image: np.ndarray, intent: ExtractionIntent, roi: tuple[float, float, float, float]) -> FeatureRefinement:
    candidates = cv2.goodFeaturesToTrack(image, maxCorners=8, qualityLevel=.01, minDistance=6, blockSize=5)
    if candidates is None:
        return _result(intent, roi, gates={"candidate": False}, reason="refinement.no-corner")
    points = candidates.reshape(-1, 2)
    center = np.array([image.shape[1] / 2, image.shape[0] / 2])
    order = np.argsort(np.linalg.norm(points - center, axis=1))
    best = points[order[0]].reshape(1, 1, 2).astype(np.float32)
    cv2.cornerSubPix(image.astype(np.float32), best, (5, 5), (-1, -1),
                     (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, .001))
    x, y = map(float, best[0, 0])
    distances = np.linalg.norm(points - center, axis=1)
    uniqueness = float(distances[order[1]] / max(distances[order[0]], .5)) if len(order) > 1 else 99.0
    response_map = cv2.cornerMinEigenVal(image, 5)
    response = float(response_map[min(image.shape[0] - 1, max(0, round(y))), min(image.shape[1] - 1, max(0, round(x)))])
    gates = {"candidate": True, "borderMargin": 5 <= x < image.shape[1] - 5 and 5 <= y < image.shape[0] - 5,
             "unique": uniqueness >= 1.2}
    point = _global((x, y), roi)
    geometry = RefinementGeometry(kind="corner", point=point, response=max(0, response), uniquenessRatio=max(1, uniqueness))
    return _result(intent, roi, point=point if all(gates.values()) else None, confidence=min(1, uniqueness / 3),
                   residual=0.0, gates=gates, reason=None if all(gates.values()) else "refinement.ambiguous-corner",
                   geometry=geometry)


def refine_feature(image: np.ndarray, intent: ExtractionIntent,
                   roi: tuple[float, float, float, float]) -> FeatureRefinement:
    gray = _gray(image)
    if intent == ExtractionIntent.circle_center:
        return _ellipse(gray, intent, roi)
    if intent in (ExtractionIntent.crosshair_center, ExtractionIntent.diagonal_center):
        return _lines(gray, intent, roi)
    if intent in (ExtractionIntent.corner, ExtractionIntent.natural_keypoint):
        return _corner(gray, intent, roi)
    normalized = gray.astype(np.float64) - float(np.median(gray))
    weights = np.abs(normalized)
    mass = float(weights.sum())
    if mass <= 1e-8:
        return _result(intent, roi, gates={"contrast": False}, reason="refinement.low-contrast")
    yy, xx = np.indices(gray.shape)
    point = _global((float((xx * weights).sum() / mass), float((yy * weights).sum() / mass)), roi)
    return _result(intent, roi, point=point, confidence=.8, residual=0.0, gates={"contrast": True},
                   geometry=RefinementGeometry(kind="corner", point=point, response=1, uniquenessRatio=99))
