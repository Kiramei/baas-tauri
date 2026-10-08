import importlib.util
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "android_cv2", ROOT / "src-tauri/gen/android/app/src/main/python/android_backend/cv2_compat.py"
)
android_cv2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(android_cv2)


class AndroidTemplateMatchingTest(unittest.TestCase):
    def test_matches_opencv_for_grayscale_color_and_cropped_comparisons(self):
        rng = np.random.default_rng(27)
        for channels in (None, 3, 4):
            shape = (41, 53) if channels is None else (41, 53, channels)
            source = rng.integers(0, 256, shape, dtype=np.uint8)
            for target in (source[9:18, 17:28].copy(), source.copy()):
                for method in (cv2.TM_CCOEFF_NORMED, cv2.TM_SQDIFF):
                    with self.subTest(channels=channels, shape=target.shape, method=method):
                        expected = cv2.matchTemplate(source, target, method)
                        actual = android_cv2.matchTemplate(source, target, method)
                        # OpenCV's float32 correlation can leave a small SQDIFF
                        # residual even for an exact match; bound it by energy.
                        tolerance = (4 * np.finfo(np.float32).eps * np.sum(target.astype(np.float64) ** 2)
                                     if method == cv2.TM_SQDIFF else 2e-6)
                        np.testing.assert_allclose(actual, expected, rtol=1e-5, atol=tolerance)
                        self.assertEqual(actual.dtype, np.float32)
                        self.assertEqual(android_cv2.minMaxLoc(actual)[3], cv2.minMaxLoc(expected)[3])

    def test_constant_channels_use_opencv_normalization(self):
        source = np.zeros((23, 29, 3), dtype=np.uint8)
        source[:] = [20, 80, 160]
        constant_template = source[:7, :9].copy()
        varying_template = constant_template.copy()
        varying_template[1, 1] = [30, 60, 90]
        for target in (constant_template, varying_template):
            np.testing.assert_allclose(
                android_cv2.matchTemplate(source, target, cv2.TM_CCOEFF_NORMED),
                cv2.matchTemplate(source, target, cv2.TM_CCOEFF_NORMED), atol=1e-6
            )


if __name__ == "__main__":
    unittest.main()
