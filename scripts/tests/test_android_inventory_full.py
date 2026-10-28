import ast
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "src-tauri/gen/android/app/src/main/python/android_backend"
ENV = {"BAAS_ANDROID": "1", "BAAS_ANDROID_NATIVE_CAPTURE": "1"}


def load(name):
    spec = importlib.util.spec_from_file_location(name, ADAPTER / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def raw(text, score=0.99):
    return {"text": text, "char_scores": [score] * len(text)}


def notice():
    return list(map(raw, ("通知", "以上道具的库存已满。", "请先整理库存。", "确认")))


class Frame:
    """Synthetic layout only; never include private game/account screenshots."""
    ndim = 3
    shape = (720, 1280, 3)

    def __init__(self, shown=True):
        self.pixels = {(60, 40): (30, 80, 130), (640, 40): (245, 245, 245), (1240, 40): (40, 80, 120)}
        if shown:
            for point in ((580, 120), (700, 120), (360, 375), (380, 580)):
                self.pixels[point] = (247, 247, 246)
            for point in ((920, 375), (880, 580)):
                self.pixels[point] = (212, 228, 239)
            for point in ((900, 128), (910, 138), (920, 148)):
                self.pixels[point] = (45, 70, 99)
            for point in ((540, 505), (740, 505), (545, 552), (730, 552)):
                self.pixels[point] = (105, 213, 255)

    def __getitem__(self, position):
        y, x, _channels = position
        return self.pixels.get((x, y), (20, 20, 20))[::-1]


def baas():
    instance = types.SimpleNamespace(server="CN", flag_run=True, ratio=1.0,
                                     latest_img_array=Frame(), logger=Mock(), click=Mock(),
                                     ocr=Mock(), next_time=123, signal_stop=Mock())
    instance.signal_stop.side_effect = lambda: setattr(instance, "flag_run", False)
    frames = iter((Frame(), Frame(), Frame(False), Frame(False)))
    instance.update_screenshot_array = Mock(side_effect=lambda: setattr(instance, "latest_img_array", next(frames)))
    return instance


COLOR = '''import time
def wait_loading(self):
    startTime = time.time()
    while self.flag_run and loading(self):
        self.update_screenshot_array()
        loadingTime = time.time() - startTime
        time.sleep(0.1)
'''
# wait_loading from baas-dev master 5658a048: a fresh frame may end loading
# before loadingTime is measured. Keep both the stop and confirmed-page exits.
COLOR_HOME_GUARD = '''import time
def wait_loading(self):
    startTime = time.time()
    # Home artwork can match the sparse loading colors. A confirmed page
    # must take precedence so navigation can inspect its own end conditions.
    while (self.flag_run and not match_rgb_feature(self, "main_page") and
           match_rgb_feature(self, "loadingNotWhite") and match_rgb_feature(self, "loadingWhite")):
        self.update_screenshot_array()
        if not self.flag_run or match_rgb_feature(self, "main_page"):
            break
        loadingTime = round(time.time() - startTime, 3)
        self.logger.info("Detected loading, loading time: " + str(loadingTime))
        time.sleep(self.screenshot_interval)
    return
'''
PICTURE = '''import time
def co_detect(self):
    while self.flag_run:
        # loading check
        wait_loading(self)
        return True
'''
THREAD = '''import time
class Baas_thread:
    def solve(self, activity) -> bool:
        try:
                return func_dict[activity](self)
        except FunctionCallTimeout:
                return self.restart_game()
'''
# Match the indentation of the real solver's try/except nested in its retry loop.
THREAD = THREAD.replace("        try:\n", "        for attempt in range(3):\n            try:\n")
THREAD = THREAD.replace("        except FunctionCallTimeout:\n", "            except FunctionCallTimeout:\n")
THREAD += '''
    def thread_starter(self):
        try:
            return self.finish_round()
        except Exception as e:
            self.logger.error(traceback.format_exc())
            return False
'''


class AndroidInventoryFullTest(unittest.TestCase):
    def test_requires_exact_complete_text_not_generic_confirm_or_purchase(self):
        guard = load("inventory_full")
        self.assertTrue(guard.matches_inventory_full_text(notice()))
        normalized = list(map(raw, (" 通知 ", "以上道具的库存已满.", "请先整理库存.", "确认")))
        self.assertTrue(guard.matches_inventory_full_text(normalized))
        for line, text in ((0, "购买"), (1, "是否消耗青辉石恢复行动点？"),
                           (1, "以上道具的库存未满。"), (1, "库存已满。"),
                           (1, "以上道具的库存已满。是否购买？"),
                           (2, "是否整理库存？"), (3, "购买"), (3, "确认购买")):
            with self.subTest(line=line, text=text):
                results = notice()
                results[line] = raw(text)
                self.assertFalse(guard.matches_inventory_full_text(results))

    def test_uncertain_missing_or_invalid_scores_cannot_drop_characters_into_a_match(self):
        guard = load("inventory_full")
        for result in (None, {}, raw("通知", 0.79), {"text": "通知", "char_scores": [0.99]},
                       {"text": "通知", "char_scores": [True, 0.99]},
                       {"text": "通知", "char_scores": [float("nan"), 0.99]},
                       {"text": "通知", "char_scores": [float("inf"), 0.99]},
                       {"text": "通知", "char_scores": [1.1, 0.99]},
                       {"text": "通知", "char_scores": [10 ** 1000, 0.99]}):
            with self.subTest(result=result):
                results = notice()
                results[0] = result
                self.assertFalse(guard.matches_inventory_full_text(results))
        for line, index in ((1, 0), (1, 7), (1, 9), (2, 0), (3, 1)):
            results = notice()
            results[line]["char_scores"][index] = 0.1
            self.assertFalse(guard.matches_inventory_full_text(results))

    def test_layout_requires_native_dimensions_panel_button_and_close_x(self):
        guard = load("inventory_full")
        self.assertTrue(guard.has_inventory_full_layout(Frame()))
        for frame in (None, Frame(False), types.SimpleNamespace(ndim=2),
                      types.SimpleNamespace(ndim=3, shape=(1280, 720, 3))):
            self.assertFalse(guard.has_inventory_full_layout(frame))
        for point in ((580, 120), (920, 375), (910, 138), (540, 505)):
            frame = Frame()
            frame.pixels[point] = (20, 20, 20)
            self.assertFalse(guard.has_inventory_full_layout(frame))

    def test_two_fresh_verified_frames_close_only_x_and_report_unclaimed(self):
        guard = load("inventory_full")
        instance = baas()
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", side_effect=(notice(), notice())) as read:
            with self.assertRaises(guard.InventoryFull) as caught:
                guard.handle_inventory_full(instance)
        self.assertTrue(caught.exception.closed)
        instance.click.assert_called_once_with(910, 138, wait_over=True)
        self.assertEqual(read.call_count, 2)
        self.assertEqual(instance.update_screenshot_array.call_count, 4)
        instance.signal_stop.assert_not_called()
        self.assertTrue(instance.flag_run)
        self.assertEqual(instance.last_click_name, "android_inventory_full_close")

    def test_unknown_text_or_changed_second_frame_never_clicks(self):
        guard = load("inventory_full")
        unknown = notice()
        unknown[1] = raw("是否购买行动点？")
        for responses in ((unknown,), (notice(), unknown)):
            instance = baas()
            with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                    patch.object(guard, "_read_notice", side_effect=responses):
                with self.assertRaises(guard.InventoryFull) as caught:
                    guard.handle_inventory_full(instance)
                self.assertFalse(caught.exception.closed)
            instance.click.assert_not_called()

    def test_failed_close_is_bounded_and_never_retries_x_on_stale_notice(self):
        guard = load("inventory_full")
        instance = baas()
        instance.update_screenshot_array.side_effect = None
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", side_effect=lambda *_args: notice()):
            with self.assertRaises(guard.InventoryFull) as caught:
                guard.handle_inventory_full(instance)
            self.assertFalse(caught.exception.closed)
            self.assertEqual(instance.update_screenshot_array.call_count, 7)
            with self.assertRaisesRegex(guard.InventoryFull, "not clicking again"):
                guard.handle_inventory_full(instance)
        instance.click.assert_called_once_with(910, 138, wait_over=True)

    def test_ocr_failure_or_manual_stop_between_frames_cannot_authorize_close(self):
        guard = load("inventory_full")
        instance = baas()
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", side_effect=(notice(), ValueError("OCR failed"))):
            with self.assertRaises(guard.InventoryFull) as caught:
                guard.handle_inventory_full(instance)
        self.assertFalse(caught.exception.closed)
        instance.click.assert_not_called()
        instance = baas()
        instance.update_screenshot_array.side_effect = lambda: setattr(instance, "flag_run", False)
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", return_value=notice()):
            self.assertFalse(guard.handle_inventory_full(instance))
        instance.click.assert_not_called()

    def test_only_three_explicit_claim_tasks_continue_after_verified_close(self):
        guard = load("inventory_full")
        for activity in ("mail", "collect_daily_power", "collect_reward", "restart", "cafe_reward", None):
            instance = baas()
            with patch.dict(os.environ, ENV):
                continued = guard.finish_inventory_full_task(instance, activity, guard.InventoryFull(True))
            if activity in guard.CLAIM_TASKS:
                self.assertTrue(continued)
                self.assertTrue(instance.flag_run)
                self.assertEqual(instance.next_time, 0)
                self.assertIn("SKIPPED " + activity + " due to inventory full; rewards remain unclaimed", instance.logger.warning.call_args.args[0])
                instance.signal_stop.assert_not_called()
            else:
                self.assertFalse(continued)
                self.assertFalse(instance.flag_run)
                instance.signal_stop.assert_called_once()
        instance = baas()
        with patch.dict(os.environ, ENV):
            self.assertFalse(guard.finish_inventory_full_task(instance, "mail", guard.InventoryFull(False)))
        instance.signal_stop.assert_called_once()

    def test_non_native_other_server_and_stopped_tasks_are_unchanged(self):
        guard = load("inventory_full")
        for overrides in ({"BAAS_ANDROID": "0"}, {"BAAS_ANDROID_NATIVE_CAPTURE": "0"}, {"server": "JP"}, {"flag_run": False}):
            instance = baas()
            env = {**ENV, **{key: value for key, value in overrides.items() if key.startswith("BAAS_")}}
            for key, value in overrides.items():
                if not key.startswith("BAAS_"):
                    setattr(instance, key, value)
            with patch.dict(os.environ, env), patch.object(guard, "_read_notice") as read:
                self.assertFalse(guard.handle_inventory_full(instance))
                self.assertTrue(guard.check_claim_task_result(instance, "mail", True))
            read.assert_not_called()
            instance.update_screenshot_array.assert_not_called()
            instance.click.assert_not_called()

    def test_post_claim_guard_runs_before_success_but_never_hides_an_existing_failure(self):
        guard = load("inventory_full")
        instance = baas()
        with patch.dict(os.environ, ENV), patch.object(guard, "handle_inventory_full", side_effect=guard.InventoryFull(True)) as check:
            with self.assertRaises(guard.InventoryFull):
                guard.check_claim_task_result(instance, "mail", True)
            check.assert_called_once_with(instance)
            instance.update_screenshot_array.assert_called_once()
            check.reset_mock()
            self.assertFalse(guard.check_claim_task_result(instance, "mail", False))
            self.assertTrue(guard.check_claim_task_result(instance, "group", True))
            check.assert_not_called()

    def test_ocr_uses_raw_complete_response_bounded_http_and_no_shared_memory(self):
        guard = load("inventory_full")
        instance = baas()
        instance.ocr.client.config.base_url = "http://127.0.0.1:1145"
        instance.ocr.client.get_image_bytes.return_value = b"PNG"
        response = Mock(status_code=200, text=json.dumps(raw("通知")))
        request = Mock(return_value=response)
        with patch.dict(sys.modules, {"requests": types.SimpleNamespace(post=request)}):
            self.assertEqual(guard._read_line(instance, instance.latest_img_array, 1.0, (1, 2, 3, 4), 0.2), raw("通知"))
        self.assertEqual(request.call_args.args, ("http://127.0.0.1:1145/ocr_for_single_line",))
        self.assertEqual(request.call_args.kwargs["timeout"], (0.2, 0.2))
        self.assertEqual(json.loads(request.call_args.kwargs["files"]["data"][1])["image"], {"pass_method": 1})
        self.assertEqual(request.call_args.kwargs["files"]["image"][1], b"PNG")
        response.close.assert_called_once()
        instance.ocr.get_region_res.assert_not_called()

    def test_ocr_deadline_stops_before_a_new_request(self):
        guard = load("inventory_full")
        with patch.object(guard.time, "monotonic", return_value=2), patch.object(guard, "_read_line") as read:
            with self.assertRaises(TimeoutError):
                guard._read_notice(baas(), 1)
        read.assert_not_called()

    def test_unknown_first_frame_or_ocr_transport_failure_stops_without_clicking(self):
        guard = load("inventory_full")
        for failure in (ValueError("bad OCR"), TimeoutError("OCR unavailable")):
            instance = baas()
            with patch.dict(os.environ, ENV), patch.object(guard, "_read_notice", side_effect=failure):
                with self.assertRaises(guard.InventoryFull) as caught:
                    guard.handle_inventory_full(instance)
            self.assertFalse(caught.exception.closed)
            instance.click.assert_not_called()

    def test_invalid_ratios_never_change_coordinates_or_click(self):
        guard = load("inventory_full")
        for ratio in (0, 0.5, 2, True, None, float("nan"), float("inf")):
            instance = baas()
            instance.ratio = ratio
            with patch.dict(os.environ, ENV), patch.object(guard, "_read_notice") as read:
                with self.assertRaises(guard.InventoryFull):
                    guard.handle_inventory_full(instance)
            read.assert_not_called()
            instance.click.assert_not_called()

    def test_invalid_black_or_uniform_close_frames_do_not_count_as_a_closed_notice(self):
        guard = load("inventory_full")
        black = Frame(False)
        black.pixels = {}
        white = Frame(False)
        white.pixels = {point: (255, 255, 255) for point in
                        ((60, 40), (640, 40), (1240, 40), (350, 360), (640, 360),
                         (900, 360), (60, 680), (640, 680), (1240, 680))}
        for invalid in (None, black, white, types.SimpleNamespace(ndim=3, shape=(1280, 720, 3))):
            instance = baas()
            frames = iter((Frame(), Frame(), *([invalid] * 5)))
            instance.update_screenshot_array.side_effect = lambda: setattr(instance, "latest_img_array", next(frames))
            with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                    patch.object(guard, "_read_notice", side_effect=(notice(), notice())):
                with self.assertRaises(guard.InventoryFull) as caught:
                    guard.handle_inventory_full(instance)
            self.assertFalse(caught.exception.closed)
            instance.click.assert_called_once_with(910, 138, wait_over=True)

    def test_uniform_colored_frames_have_no_spatial_ui_detail_and_cannot_verify_close(self):
        guard = load("inventory_full")
        points = ((60, 40), (640, 40), (1240, 40), (350, 360), (640, 360),
                  (900, 360), (60, 680), (640, 680), (1240, 680))
        for color in ((255, 0, 0), (0, 0, 255), (10, 100, 200), (150, 150, 150)):
            frame = Frame(False)
            frame.pixels = {point: color for point in points}
            self.assertFalse(guard._valid_reference_frame(frame))
        self.assertTrue(guard._valid_reference_frame(Frame(False)))

    def test_second_capture_failure_is_not_a_solver_timeout_or_restart(self):
        guard = load("inventory_full")
        timeout = type("FunctionCallTimeout", (RuntimeError,), {})
        instance = baas()
        instance.update_screenshot_array.side_effect = (None, timeout("capture failed"))
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", return_value=notice()):
            with self.assertRaises(guard.InventoryFull) as caught:
                guard.handle_inventory_full(instance)
        self.assertFalse(caught.exception.closed)
        instance.click.assert_not_called()

    def test_ratio_change_during_second_ocr_cannot_scale_the_x_to_another_button(self):
        guard = load("inventory_full")
        instance = baas()
        reads = 0
        def read(*_args):
            nonlocal reads
            reads += 1
            if reads == 2:
                instance.ratio = 2
            return notice()
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", side_effect=read):
            with self.assertRaises(guard.InventoryFull) as caught:
                guard.handle_inventory_full(instance)
        self.assertFalse(caught.exception.closed)
        instance.click.assert_not_called()

    def test_verified_close_resets_attempt_for_a_later_distinct_claim_notice(self):
        guard = load("inventory_full")
        instance = baas()
        with patch.dict(os.environ, ENV), patch.object(guard.time, "sleep"), \
                patch.object(guard, "_read_notice", side_effect=lambda *_args: notice()):
            for _ in range(2):
                instance.latest_img_array = Frame()
                frames = iter((Frame(), Frame(), Frame(False), Frame(False)))
                instance.update_screenshot_array.side_effect = lambda: setattr(instance, "latest_img_array", next(frames))
                with self.assertRaises(guard.InventoryFull) as caught:
                    guard.handle_inventory_full(instance)
                self.assertTrue(caught.exception.closed)
                self.assertIsNone(getattr(instance, guard._ATTEMPT))
        self.assertEqual(instance.click.call_count, 2)

    def test_each_ocr_notice_reads_a_fixed_frame_and_ratio_even_if_shared_latest_changes(self):
        guard = load("inventory_full")
        instance = baas()
        original = instance.latest_img_array
        def read(_baas, frame, ratio, _region, _remaining):
            self.assertIs(frame, original)
            self.assertEqual(ratio, 1.0)
            instance.latest_img_array = Frame(False)
            instance.ratio = 2
            return raw("text")
        with patch.object(guard, "_read_line", side_effect=read) as reader:
            guard._read_notice(instance, guard.time.monotonic() + 1)
        self.assertEqual(reader.call_count, 4)

    def test_bootstrap_patches_all_three_boundaries_idempotently_and_catches_before_restart(self):
        bootstrap = load("bootstrap")
        guard = load("inventory_full")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "core").mkdir()
            for name, text in (("picture", PICTURE), ("color", COLOR), ("Baas_thread", THREAD)):
                (root / "core" / (name + ".py")).write_text(text)
            bootstrap._patch_android_inventory_full(root)
            first = {name: (root / "core" / (name + ".py")).read_text() for name in ("picture", "color", "Baas_thread")}
            bootstrap._patch_android_inventory_full(root)
            self.assertEqual(first, {name: (root / "core" / (name + ".py")).read_text() for name in first})
            for name, text in first.items():
                compile(text, name, "exec")
            self.assertLess(first["picture"].index("handle_inventory_full(self)"), first["picture"].index("wait_loading(self)"))
            self.assertEqual(first["color"].count("handle_inventory_full(self)"), 2)
            self.assertLess(first["Baas_thread"].index("except InventoryFull"), first["Baas_thread"].index("except FunctionCallTimeout"))
            thread_ast = ast.parse(first["Baas_thread"])
            cls = next(node for node in thread_ast.body if isinstance(node, ast.ClassDef))
            namespace = {"InventoryFull": guard.InventoryFull, "FunctionCallTimeout": type("FunctionCallTimeout", (Exception,), {}),
                         "finish_inventory_full_task": guard.finish_inventory_full_task,
                         "check_claim_task_result": guard.check_claim_task_result}
            exec(compile(ast.Module(body=[cls], type_ignores=[]), "test_solver", "exec"), namespace)
            instance = baas()
            instance.restart_game = Mock()
            namespace["func_dict"] = {"mail": Mock(side_effect=guard.InventoryFull(True))}
            with patch.dict(os.environ, ENV):
                self.assertTrue(namespace["Baas_thread"].solve(instance, "mail"))
            instance.restart_game.assert_not_called()
            namespace["func_dict"]["mail"].assert_called_once()
            instance = baas()
            instance.finish_round = Mock(side_effect=guard.InventoryFull(True))
            with patch.dict(os.environ, ENV):
                self.assertFalse(namespace["Baas_thread"].thread_starter(instance))
            instance.signal_stop.assert_called_once()
            self.assertFalse(instance.flag_run)
            self.assertFalse(instance.logger.warning.called)

    def test_wait_loading_detects_a_notice_that_arrives_inside_its_loop(self):
        bootstrap = load("bootstrap")
        guard = load("inventory_full")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "core").mkdir()
            for name, text in (("picture", PICTURE), ("color", COLOR), ("Baas_thread", THREAD)):
                (root / "core" / (name + ".py")).write_text(text)
            bootstrap._patch_android_inventory_full(root)
            tree = ast.parse((root / "core/color.py").read_text())
            function = next(node for node in tree.body if isinstance(node, ast.FunctionDef))
            check = Mock(side_effect=(False, guard.InventoryFull(True)))
            namespace = {"handle_inventory_full": check, "time": Mock(), "loading": lambda _instance: True}
            namespace["time"].time.return_value = 1
            exec(compile(ast.Module(body=[function], type_ignores=[]), "test_loading", "exec"), namespace)
            instance = baas()
            with self.assertRaises(guard.InventoryFull):
                namespace["wait_loading"](instance)
            instance.update_screenshot_array.assert_called_once()
            self.assertEqual(check.call_count, 2)
            namespace["time"].sleep.assert_not_called()

    def test_current_backend_wait_loading_preserves_fresh_home_and_stop_exits(self):
        bootstrap = load("bootstrap")
        guard = load("inventory_full")
        for exit_condition in ("home", "stop", "inventory"):
            with self.subTest(exit_condition=exit_condition), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "core").mkdir()
                for name, text in (("picture", PICTURE), ("color", COLOR_HOME_GUARD), ("Baas_thread", THREAD)):
                    (root / "core" / (name + ".py")).write_text(text)
                bootstrap._patch_android_inventory_full(root)
                source = (root / "core/color.py").read_text()
                bootstrap._patch_android_inventory_full(root)
                self.assertEqual((root / "core/color.py").read_text(), source)
                function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef))
                instance = baas()
                instance.at_home = False

                def capture():
                    instance.at_home = exit_condition == "home"
                    instance.flag_run = exit_condition != "stop"

                instance.update_screenshot_array.side_effect = capture
                check = Mock(side_effect=(False, guard.InventoryFull(True) if exit_condition == "inventory" else False))
                namespace = {"handle_inventory_full": check, "time": Mock(),
                             "match_rgb_feature": lambda value, feature: value.at_home if feature == "main_page" else True}
                namespace["time"].time.return_value = 1
                exec(compile(ast.Module(body=[function], type_ignores=[]), "current_backend_loading", "exec"), namespace)
                if exit_condition == "inventory":
                    with self.assertRaises(guard.InventoryFull):
                        namespace["wait_loading"](instance)
                else:
                    namespace["wait_loading"](instance)
                instance.update_screenshot_array.assert_called_once()
                self.assertEqual(check.call_count, 2)
                namespace["time"].sleep.assert_not_called()
                instance.logger.info.assert_not_called()


if __name__ == "__main__":
    unittest.main()
