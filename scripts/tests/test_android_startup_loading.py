import ast
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend"
spec = importlib.util.spec_from_file_location("startup_loading", ADAPTER / "startup_loading.py")
loading = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loading)
ENV = {"BAAS_ANDROID": "1", "BAAS_ANDROID_NATIVE_CAPTURE": "1"}


class Frame:
    ndim = 3
    shape = (720, 1280, 3)

    def __init__(self, spinner=True, solid=False):
        self.spinner, self.solid = spinner, solid

    def __getitem__(self, position):
        y, x, _ = position
        radius = (x - 47) ** 2 + (y - 694) ** 2
        return (220, 170, 25) if self.solid or (self.spinner and 36 <= radius <= 144) else (245, 245, 245)


def raw(text):
    return {"text": text, "char_scores": [0.99] * len(text)}


def context():
    return types.SimpleNamespace(server="CN", flag_run=True, ratio=1,
                                 latest_img_array=Frame(), logger=Mock(), ocr=Mock())


class StartupLoadingTests(unittest.TestCase):
    def test_spinner_requires_ring_not_solid_or_blank(self):
        self.assertTrue(loading.has_startup_spinner(Frame()))
        self.assertFalse(loading.has_startup_spinner(Frame(False)))
        self.assertFalse(loading.has_startup_spinner(Frame(solid=True)))
        self.assertFalse(loading.has_startup_spinner(None))
        frame = Frame()
        frame.shape = (1280, 720, 3)
        self.assertFalse(loading.has_startup_spinner(frame))

    def test_complete_known_status_only(self):
        for text in ("Initialize Catalog...", "游戏数据初始化中...", "正在初始化游戏数据……"):
            self.assertTrue(loading.matches_initialization_text(raw(text)), text)
        for text in ("", "请确认游戏数据初始化中", "初始化失败", "点击任意区域进入游戏", "购买体力", "Initialize Catalog error"):
            self.assertFalse(loading.matches_initialization_text(raw(text)), text)

    def test_all_confidences_and_full_text_required(self):
        for index in (0, 4, 11):
            result = raw("Initialize Catalog...")
            result["char_scores"][index] = 0.79
            self.assertFalse(loading.matches_initialization_text(result))
        for bad in (float("nan"), float("inf"), True, 1.1, -1):
            result = raw("游戏数据初始化中")
            result["char_scores"][0] = bad
            self.assertFalse(loading.matches_initialization_text(result))
        self.assertFalse(loading.matches_initialization_text({"text": "游戏数据初始化中", "char_scores": []}))

    def test_real_status_responses_keep_words_strict_but_ignore_dynamic_tail_confidence(self):
        responses = (
            ("InitializeCatalog.！", [0.9759, 0.9996, 0.9969, 0.9954, 0.9993, 0.9844, 0.9936, 0.9981, 0.9893, 0.9647, 0.9927, 0.9952, 0.9966, 0.9911, 0.9821, 0.9954, 0.9500, 0.8293, 0.3038], True),
            ("游戏数据初始化中.", [0.9999, 0.9979, 0.9997, 0.9989, 0.9930, 0.9694, 0.9779, 0.9878, 0.5634], True),
            ("正在初始化游戏数据……·", [0.9964, 0.9939, 0.8378, 0.6950, 0.5717, 0.9881, 0.9977, 0.9974, 0.9518, 0.4009, 0.3222, 0.4381], False),
            ("InitializeCatalog..", [0.7772, 0.9966, 0.9926, 0.9297, 0.8340, 0.8017, 0.8605, 0.4670, 0.9383, 0.8980, 0.8205, 0.7018, 0.7309, 0.4148, 0.8386, 0.9758, 0.6728, 0.8192, 0.4930], False),
        )
        for text, scores, expected in responses:
            self.assertEqual(loading.matches_initialization_text({"text": text, "char_scores": scores}), expected, text)
        self.assertFalse(loading.matches_initialization_text(raw("游戏数据初始.化中")))
        self.assertFalse(loading.matches_initialization_text(raw("游戏数据初始化中！购买")))

    def test_native_cn_only_and_no_ocr_without_spinner(self):
        with patch.dict(os.environ, ENV), patch.object(loading, "_read_status") as read:
            for key, value in (("server", "JP"), ("flag_run", False), ("ratio", 0.5), ("ratio", True), ("latest_img_array", Frame(False))):
                baas = context()
                setattr(baas, key, value)
                self.assertFalse(loading.is_startup_loading(baas))
            read.assert_not_called()
        with patch.dict(os.environ, {"BAAS_ANDROID_NATIVE_CAPTURE": "0"}):
            self.assertFalse(loading.is_startup_loading(context()))

    def test_cache_bounded_and_login_template_has_precedence(self):
        picture = types.SimpleNamespace(match_img_feature=Mock(return_value=False))
        core = types.SimpleNamespace(picture=picture)
        baas = context()
        with patch.dict(os.environ, ENV), patch.dict(sys.modules, {"core": core}), \
                patch.object(loading, "_read_status", return_value=True) as read, \
                patch.object(loading.time, "monotonic", side_effect=(0, 0, 1, 3, 3)):
            self.assertTrue(loading.is_startup_loading(baas))
            self.assertTrue(loading.is_startup_loading(baas))
            self.assertTrue(loading.is_startup_loading(baas))
            self.assertEqual(read.call_count, 2)
            picture.match_img_feature.return_value = True
            self.assertFalse(loading.is_startup_loading(baas))
            self.assertIsNone(getattr(baas, loading._CACHE))
            picture.match_img_feature.assert_called_with(baas, "main_page_login-feature", threshold=0.9, rgb_diff=12)

    def test_ocr_failure_never_promotes_unknown_to_loading(self):
        core = types.SimpleNamespace(picture=types.SimpleNamespace(match_img_feature=Mock(return_value=False)))
        with patch.dict(os.environ, ENV), patch.dict(sys.modules, {"core": core}), \
                patch.object(loading, "_read_status", side_effect=TimeoutError):
            self.assertFalse(loading.is_startup_loading(context()))

    def test_spinner_disappearance_discards_positive_cache(self):
        picture = types.SimpleNamespace(match_img_feature=Mock(return_value=False))
        baas = context()
        with patch.dict(os.environ, ENV), patch.dict(sys.modules, {"core": types.SimpleNamespace(picture=picture)}), \
                patch.object(loading, "_read_status", return_value=True) as read:
            self.assertTrue(loading.is_startup_loading(baas))
            baas.latest_img_array = Frame(False)
            self.assertFalse(loading.is_startup_loading(baas))
            self.assertIsNone(getattr(baas, loading._CACHE))
            self.assertEqual(read.call_count, 1)

    def test_negative_cache_prevents_polling_ocr_on_unknown_text(self):
        core = types.SimpleNamespace(picture=types.SimpleNamespace(match_img_feature=Mock(return_value=False)))
        baas = context()
        with patch.dict(os.environ, ENV), patch.dict(sys.modules, {"core": core}), \
                patch.object(loading, "_read_status", return_value=False) as read:
            for _ in range(5):
                self.assertFalse(loading.is_startup_loading(baas))
            read.assert_called_once()

    def test_ocr_io_has_timeout_raw_scores_and_closes_response(self):
        response = Mock(status_code=200, text='{"text":"游戏数据初始化中","char_scores":[0.99,0.99,0.99,0.99,0.99,0.99,0.99,0.99]}')
        requests = types.SimpleNamespace(post=Mock(return_value=response))
        baas = context()
        baas.ocr.client.config.base_url = "http://local-ocr"
        with patch.dict(sys.modules, {"requests": requests}):
            self.assertTrue(loading._read_status(baas, baas.latest_img_array))
        self.assertEqual(requests.post.call_args.kwargs["timeout"], (0.3, 0.8))
        response.close.assert_called_once()

    def test_uncertain_catalog_retries_english_2x_but_not_uncertain_chinese(self):
        english = raw("InitializeCatalog..")
        english["char_scores"][3] = 0.4
        with patch.object(loading, "_request_status", side_effect=(english, raw("Initialize Catalog... "))) as read:
            self.assertTrue(loading._read_status(context(), Frame()))
            self.assertEqual(read.call_args.args[2:], ("en-us", 2))
        chinese = raw("正在初始化游戏数据……")
        chinese["char_scores"][4] = 0.6
        with patch.object(loading, "_request_status", return_value=chinese) as read:
            self.assertFalse(loading._read_status(context(), Frame()))
            read.assert_called_once()

    def test_bootstrap_patch_is_idempotent_and_keeps_deadline_before_guard(self):
        source = (ADAPTER / "bootstrap.py").read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)
                        and node.name == "_patch_android_startup_loading")
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), "bootstrap", "exec"), namespace)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "core").mkdir()
            path = root / "core/picture.py"
            path.write_text('import time\ndef co_detect(self):\n    while self.flag_run:\n        if expired():\n            raise TimeoutError()\n        # loading check\n        wait_loading(self)\n')
            namespace[function.name](root)
            first = path.read_text()
            namespace[function.name](root)
            self.assertEqual(path.read_text(), first)
            self.assertLess(first.index("if expired"), first.index("if is_startup_loading"))
            self.assertIn("fail_cnt = 0", first)
            self.assertNotIn("self.click", first)


if __name__ == "__main__":
    unittest.main()
