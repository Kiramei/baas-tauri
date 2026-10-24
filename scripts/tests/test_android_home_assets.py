import importlib.util
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ADAPTER / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def response(text, scores=None, status=200):
    return types.SimpleNamespace(status_code=status, text=json.dumps({
        "text": text, "char_scores": [0.99] * len(text) if scores is None else scores,
    }))


def make_baas():
    return types.SimpleNamespace(server="CN", flag_run=True, config_set=Mock(), logger=Mock(),
                                 update_screenshot_array=Mock(), ocr=Mock(),
                                 latest_img_array=object(), ratio=1.0)


class AndroidHomeAssetsTest(unittest.TestCase):
    def test_strict_readings_do_not_truncate_bad_ocr_into_a_balance(self):
        assets = load("home_assets")
        self.assertEqual(assets.parse_reading("ap", "999/240"), {"count": 999, "max": 240})
        self.assertEqual(assets.parse_reading("creditpoints", "123,456,789"), {"count": 123456789})
        self.assertEqual(assets.parse_reading("pyroxene", "0"), {"count": 0})
        for key, value in (("ap", "999/2387"), ("ap", "10/0"), ("ap", "10"),
                           ("creditpoints", "12a34,567"), ("creditpoints", "12,34"),
                           ("pyroxene", ""), ("pyroxene", "-1")):
            with self.subTest(key=key, value=value):
                self.assertIsNone(assets.parse_reading(key, value))

    def test_waits_for_two_matching_fresh_frames_before_persisting(self):
        assets = load("home_assets")
        baas = make_baas()
        values = iter(("999/2387", "1234,567", "76,543",
                       "999/240", "123,456,789", "76,543",
                       "999/240", "123,456,789"))
        baas.ocr.client.ocr_for_single_line.side_effect = lambda **kwargs: response(next(values))
        with patch.dict(os.environ, {"BAAS_ANDROID": "1", "BAAS_ANDROID_NATIVE_CAPTURE": "1"}), \
                patch.object(assets.time, "sleep"), patch.object(assets.time, "time", return_value=100):
            self.assertTrue(assets.update_home_assets(baas))
        self.assertEqual(baas.update_screenshot_array.call_count, 3)
        written = {call.args[0]: call.args[1] for call in baas.config_set.set.call_args_list}
        self.assertEqual(written["ap"], {"count": 999, "max": 240, "time": 100})
        self.assertEqual(written["creditpoints"], {"count": 123456789, "time": 100})
        self.assertEqual(written["pyroxene"], {"count": 76543, "time": 100})
        baas.logger.warning.assert_not_called()
        regions = [call.args[1] for call in baas.ocr.get_area_img.call_args_list]
        self.assertIn((654, 22, 798, 52), regions)
        baas.ocr.get_region_res.assert_not_called()
        for call in baas.ocr.client.ocr_for_single_line.call_args_list:
            self.assertEqual(call.kwargs["language"], "en-us")
            self.assertEqual(call.kwargs["pass_method"], 1)
            self.assertIs(call.kwargs["origin_image"], baas.ocr.get_area_img.return_value)
            self.assertNotIn("shared_memory_name", call.kwargs)

    def test_unstable_readings_preserve_existing_values_and_cancellation_stops(self):
        assets = load("home_assets")
        baas = make_baas()
        baas.ocr.client.ocr_for_single_line.return_value = response("invalid")
        with patch.dict(os.environ, {"BAAS_ANDROID": "1", "BAAS_ANDROID_NATIVE_CAPTURE": "1"}), \
                patch.object(assets.time, "sleep"):
            self.assertTrue(assets.update_home_assets(baas))
            self.assertEqual(baas.update_screenshot_array.call_count, 4)
            baas.config_set.set.assert_not_called()
            self.assertEqual(baas.logger.warning.call_count, 3)
            baas.flag_run = False
            baas.update_screenshot_array.reset_mock()
            self.assertTrue(assets.update_home_assets(baas))
            baas.update_screenshot_array.assert_not_called()

    def test_low_confidence_digits_and_separators_reject_the_complete_line(self):
        assets = load("home_assets")
        for key, text, low_index in (("creditpoints", "123,456,789", 0),
                                     ("ap", "999/240", 4), ("ap", "999/240", 3),
                                     ("pyroxene", "76,543", 2)):
            with self.subTest(key=key, text=text, low_index=low_index):
                scores = [0.99] * len(text)
                scores[low_index] = 0.1
                self.assertIsNone(assets.parse_raw_reading(key, {"text": text, "char_scores": scores}))

        self.assertEqual(assets.parse_raw_reading("creditpoints", {
            "text": "123,456,789", "char_scores": [0.99] * 11,
        }), {"count": 123456789})

    def test_two_stable_low_confidence_frames_cannot_persist_truncated_values(self):
        assets = load("home_assets")
        baas = make_baas()
        readings = []
        for text, low_index in (("999/240", 4), ("123,456,789", 0), ("76,543", 2)):
            scores = [0.99] * len(text)
            scores[low_index] = 0.1
            readings.append(response(text, scores))
        baas.ocr.client.ocr_for_single_line.side_effect = readings * 4
        with patch.dict(os.environ, {"BAAS_ANDROID": "1", "BAAS_ANDROID_NATIVE_CAPTURE": "1"}), \
                patch.object(assets.time, "sleep"):
            self.assertTrue(assets.update_home_assets(baas))
        baas.config_set.set.assert_not_called()
        self.assertEqual(baas.update_screenshot_array.call_count, 4)
        self.assertEqual(baas.logger.warning.call_count, 3)

    def test_raw_response_requires_complete_finite_per_character_scores(self):
        assets = load("home_assets")
        for result in (None, [], {}, {"text": "123"}, {"text": 123, "char_scores": [0.99] * 3},
                       {"text": "123", "char_scores": [0.99]},
                       {"text": "123", "char_scores": [0.99, "0.99", 0.99]},
                       {"text": "123", "char_scores": [0.99, float("nan"), 0.99]},
                       {"text": "123", "char_scores": [0.99, float("inf"), 0.99]},
                       {"text": "123", "char_scores": [0.99, True, 0.99]},
                       {"text": "123", "char_scores": [0.99, 10 ** 1000, 0.99]},
                       {"text": "123", "char_scores": [0.99, 1.1, 0.99]}):
            with self.subTest(result=result):
                self.assertIsNone(assets.parse_raw_reading("creditpoints", result))

    def test_response_and_transport_errors_preserve_previous_values_and_warn(self):
        assets = load("home_assets")
        for failure in (response("123", status=500), types.SimpleNamespace(status_code=200, text="not json"),
                        RuntimeError("OCR is unavailable")):
            with self.subTest(failure=failure):
                baas = make_baas()
                if isinstance(failure, Exception):
                    baas.ocr.client.ocr_for_single_line.side_effect = failure
                else:
                    baas.ocr.client.ocr_for_single_line.return_value = failure
                with patch.dict(os.environ, {"BAAS_ANDROID": "1", "BAAS_ANDROID_NATIVE_CAPTURE": "1"}), \
                        patch.object(assets.time, "sleep"):
                    self.assertTrue(assets.update_home_assets(baas))
                baas.config_set.set.assert_not_called()
                self.assertTrue(any("preserving previous" in call.args[0]
                                    for call in baas.logger.warning.call_args_list))

    def test_other_platforms_and_servers_keep_original_readings(self):
        assets = load("home_assets")
        for android, native, server in (("0", "1", "CN"), ("1", "0", "CN"), ("1", "1", "JP")):
            with self.subTest(android=android, native=native, server=server), \
                    patch.dict(os.environ, {"BAAS_ANDROID": android, "BAAS_ANDROID_NATIVE_CAPTURE": native}):
                self.assertFalse(assets.update_home_assets(types.SimpleNamespace(server=server)))

    def test_bootstrap_injection_is_idempotent_and_retains_original_fallback(self):
        bootstrap = load("bootstrap")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "core/Baas_thread.py"
            target.parent.mkdir()
            original = "    def main_page_update_data(self):\n        self.get_ap(True)\n"
            target.write_text(original)
            bootstrap._patch_android_home_asset_readings(root)
            first = target.read_text()
            bootstrap._patch_android_home_asset_readings(root)
            self.assertEqual(first, target.read_text())
            self.assertIn("if update_home_assets(self):\n            return", first)
            self.assertIn("self.get_ap(True)", first)


if __name__ == "__main__":
    unittest.main()
