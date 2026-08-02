from time import perf_counter

import numpy as np

from app.algorithms import fit_weighted_center


def test_circle_fitting_exceeds_30_fps() -> None:
    yy, xx = np.indices((64, 64))
    patch = np.exp(-((np.hypot(xx - 31.4, yy - 32.2) - 9) ** 2) / 4).astype(np.float32)
    started = perf_counter()
    for frame in range(300):
        fit_weighted_center(patch, frame=frame)
    fps = 300 / (perf_counter() - started)
    assert fps >= 30
