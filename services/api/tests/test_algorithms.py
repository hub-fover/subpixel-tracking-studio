import numpy as np

from app.algorithms import fit_weighted_center


def test_circle_center_is_subpixel_accurate() -> None:
    yy, xx = np.indices((48, 48))
    expected = (24.35, 23.7)
    radius = np.hypot(xx - expected[0], yy - expected[1])
    patch = np.exp(-((radius - 8) ** 2) / (2 * 1.4**2)).astype(np.float32)
    result = fit_weighted_center(patch)
    assert np.hypot(result.x - expected[0], result.y - expected[1]) <= 0.1
