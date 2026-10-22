import importlib.util
from pathlib import Path
import unittest

import cv2
import numpy as np

source = Path(__file__).resolve().parents[1] / "scripts" / "probe-device-capture.py"
spec = importlib.util.spec_from_file_location("device_capture_probe", source)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def frame(token):
    image = np.full((1280, 720, 3), 16, dtype=np.uint8)
    cv2.rectangle(image, (24, 24), (53, 53), (255, 0, 255), -1)
    for index, color in enumerate([(0, 0, 255), (0, 255, 0), (255, 0, 0)]):
        left = 90 + 48 * index
        cv2.rectangle(image, (left, 24), (left + 29, 53), color, -1)
    for bit in range(16):
        left = 24 + 36 * bit
        value = 245 if token & (1 << bit) else 32
        cv2.rectangle(image, (left, 132), (left + 26, 167), (value, value, value), -1)
    return image


class FrameValidationTest(unittest.TestCase):
    def test_bgr_and_rgb_are_detected_without_changing_pixels(self):
        image = frame(36123)
        original = image.copy()
        bgr = probe.validate_frame(image, 36123, 1.5, 480, 854)
        rgb = probe.validate_frame(image[:, :, ::-1], 36123, 1.5, 480, 854)
        self.assertEqual(bgr["channelOrder"], "BGR")
        self.assertEqual(rgb["channelOrder"], "RGB")
        self.assertEqual(bgr["token"], 36123)
        self.assertEqual(bgr["colorMeanAbsoluteError"], 0)
        np.testing.assert_array_equal(image, original)

    def test_stale_frame_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "fixture-token-mismatch"):
            probe.validate_frame(frame(7), 8, 1.5, 480, 854)

    def test_black_missing_malformed_and_wrong_dimensions_are_rejected(self):
        for image in [None, np.zeros((1280, 720)), np.zeros((1280, 720, 3), dtype=np.uint8), frame(1)[:500]]:
            with self.assertRaises(ValueError):
                probe.validate_frame(image, 1, 1.5, 480, 854)

    def test_incorrect_color_calibration_is_rejected(self):
        image = frame(1)
        image[24:54, 90:216] = 16
        with self.assertRaisesRegex(ValueError, "fixture-color-calibration-failed"):
            probe.validate_frame(image, 1, 1.5, 480, 854)


if __name__ == "__main__":
    unittest.main()
