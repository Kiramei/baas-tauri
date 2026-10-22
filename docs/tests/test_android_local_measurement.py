import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

FILE = Path(__file__).resolve().parents[1] / "scripts/measure-android-local-worker.py"
SPEC = importlib.util.spec_from_file_location("android_local_worker", FILE)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def fixture_frame(token=31001, inputs=7, frame=95, duration=300):
    image = np.full((720, 1280, 3), 235, dtype=np.uint8)
    for x, color in [(32, [255, 0, 255]), (112, [0, 0, 255]), (172, [0, 255, 0]), (232, [255, 0, 0])]:
        image[20:44, x-12:x+12] = color
    for y, value in zip([85, 145, 205, 265], [token, inputs, frame, duration]):
        for bit in range(16):
            x = 32 + bit * 72
            image[y:y+40, x:x+48] = 245 if value & (1 << bit) else 24
    image[390:600, 940:1200] = worker.texture_reference()
    return image


class AndroidLocalMeasurementTest(unittest.TestCase):
    def test_probe_and_formal_plans_keep_distinct_sample_counts(self):
        for probe, capture, control in [(True, 8, 3), (False, 400, 216)]:
            plan = worker.measurement_plan(probe)
            self.assertEqual(plan["captureBlocks"] * 2 * 2 * plan["captureTrials"], capture)
            self.assertEqual(plan["controlBlocks"] * 3 * plan["controlTrials"], control)

    def test_decodes_fixture_token_inputs_frame_duration_and_BGR(self):
        self.assertEqual(worker.decode_frame(fixture_frame(), 31001), {"token": 31001, "inputs": 7, "frame": 95, "durationMs": 300})
        for bad in [fixture_frame()[:, :, ::-1], np.zeros((10, 10, 3), dtype=np.uint8), fixture_frame().astype(np.float32)]:
            with self.assertRaises(ValueError):
                worker.decode_frame(bad, 31001)
        with self.assertRaisesRegex(ValueError, "stale-fixture-token"):
            worker.decode_frame(fixture_frame(), 31002)
        ambiguous = fixture_frame()
        ambiguous[85:125, 32:80] = 128
        with self.assertRaisesRegex(ValueError, "ambiguous-barcode"):
            worker.decode_frame(ambiguous)

    def test_reference_matches_Java_unsigned_texture_arithmetic(self):
        reference = worker.texture_reference()
        for row, column in [(0, 0), (99, 101), (209, 259)]:
            x, y = column + 40, row + 40
            seed = (((x // 4) * 73856093) ^ ((y // 4) * 19349663) ^ 83492791) & 0xffffffff
            seed ^= seed >> 13
            self.assertEqual(reference[row, column].tolist(), [40 + ((seed >> 16) & 127), 40 + ((seed >> 8) & 127), 40 + (seed & 127)])
        self.assertEqual(worker.quality_mse(fixture_frame(), reference), 0.0)
        changed = fixture_frame()
        changed[390:600, 940:1200] = 0
        self.assertGreater(worker.quality_mse(changed, reference), 100)

    def test_capture_timer_ends_at_adapter_return_before_verification(self):
        measure = object.__new__(worker.Measurement)
        measure.guard = lambda: None
        measure.raw = SimpleNamespace(screenshot=fixture_frame)
        measure.reference = worker.texture_reference()
        with patch.object(worker.time, "perf_counter_ns", side_effect=[100, 175]):
            result, frame = measure.capture_sample("adapter", 31001, 95)
        self.assertEqual(result["elapsedNs"], 75)
        self.assertEqual(result["outputBytes"], 1280 * 720 * 3)
        self.assertEqual(frame, 95)
        self.assertTrue(result["repeatedFrame"])
        self.assertEqual(result["mse"], 0)
        self.assertIsNone(result["scriptGapBeforeCallMs"])

    def test_input_validation_rejects_extra_events_missing_motion_and_wrong_holds(self):
        observed = {"inputs": 8, "width": 1280, "height": 720, "travelPixels": 400, "durationMs": 300}
        worker.validate_input("swipe", observed, 8)
        for changes in [{"inputs": 9}, {"width": 720}, {"travelPixels": 0}, {"durationMs": 1}]:
            with self.assertRaises(ValueError):
                worker.validate_input("swipe", {**observed, **changes}, 8)
        worker.validate_input("click", {**observed, "travelPixels": 0, "durationMs": 50}, 8)
        worker.validate_input("long_click", {**observed, "travelPixels": 0}, 8)
        with self.assertRaises(ValueError):
            worker.validate_input("long_click", observed, 8)

    def test_control_orders_balance_each_position_and_yield_72_trials_per_scenario(self):
        counts = {(name, position): 0 for name in ["click", "swipe", "long_click"] for position in range(3)}
        for block in range(24):
            order = worker.CONTROL_ORDERS[block % 6]
            self.assertEqual(set(order), {"click", "swipe", "long_click"})
            for position, scenario in enumerate(order):
                counts[scenario, position] += 3
        self.assertEqual(set(counts.values()), {24})


if __name__ == "__main__":
    unittest.main()
