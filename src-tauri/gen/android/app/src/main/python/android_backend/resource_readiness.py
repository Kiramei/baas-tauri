"""Verify shared script resources before exposing an Android runtime as ready."""

import functools
import json
import threading
import traceback
from pathlib import Path


def validate_ocr_model_assets(client):
    """Check all supported region assets without loading five model sets into RAM."""
    root = Path(client.server_folder_path) / "resource"
    catalog = json.loads((root / "static.json").read_text(encoding="utf-8"))
    models = catalog.get("ocr_model_name", {})
    for language in ("en-us", "zh-cn", "ja-jp", "zh-tw", "ko-kr"):
        definition = models.get(language)
        if not isinstance(definition, dict):
            raise RuntimeError("Missing OCR model definition: " + language)
        for component in ("det", "cls", "rec", "dict"):
            name = definition.get(component)
            if not isinstance(name, str) or Path(name).name != name:
                raise RuntimeError("Invalid OCR model asset: " + language + "/" + component)
            asset = root / "ocr_models" / name
            if not asset.is_file() or not asset.stat().st_size:
                raise RuntimeError("Missing OCR model asset: " + language + "/" + name)
        image = root / "ocr_models" / "test_images" / (language + ".png")
        if not image.is_file() or not image.stat().st_size:
            raise RuntimeError("Missing OCR recognition test image: " + language)


def validate_script_resources(root):
    """Read the packaged static/RGB catalogs without opening a game or device."""
    root = Path(root)
    static = json.loads((root / "config" / "static.json").read_text(encoding="utf-8"))
    if not isinstance(static, dict) or not static:
        raise RuntimeError("The script static configuration is empty or invalid")
    for identifier in ("CN", "JP", "Global_en-us", "Global_zh-tw", "Global_ko-kr"):
        rgb = json.loads((root / "src" / "rgb_feature" / (identifier + ".json")).read_text(encoding="utf-8"))
        if not isinstance(rgb, dict) or not isinstance(rgb.get("rgb_feature"), dict):
            raise RuntimeError("Invalid RGB resource catalog: " + identifier)
        images = root / "src" / "images" / identifier
        if not any((images / "x_y_range").rglob("*.py")) or not any(images.rglob("*.png")):
            raise RuntimeError("Missing image resources: " + identifier)


def install_runtime_readiness(runtime_class, report, timeout_seconds=600, validate_resources=None, validate_ocr_assets=None):
    """Wrap the real backend initializer, retaining its config/status protocol.

    OCR constructors already initialize their models. A real recognition probe
    also verifies their native server/model assets, including cached installs.
    The transport stays available when initialization fails, so setup can show
    diagnostics and restart the isolated backend without opening the main UI.
    """
    if getattr(runtime_class, "_android_resource_readiness_installed", False):
        return
    original = runtime_class.init_all_data
    validate_resources = validate_resources or validate_script_resources
    validate_ocr_assets = validate_ocr_assets or validate_ocr_model_assets

    @functools.wraps(original)
    def initialize(runtime, *args, **kwargs):
        lock = threading.RLock()
        state = {"finished": False, "failed": False, "ocr": False, "static": False}
        runtime._android_resources_ready = False
        runtime._android_resource_error = None

        def fail(error, trace=""):
            with lock:
                if state["finished"] or state["failed"]:
                    return
                state["failed"] = True
                runtime._android_resource_error = str(error)
                runtime.is_all_data_initialized = False
                report("resources", "failed", str(error), trace)

        def check_active():
            if state["failed"]:
                raise RuntimeError(runtime._android_resource_error)

        def progress(step, detail):
            with lock:
                check_active()
                report(step, "running", detail, "")

        main = runtime._main
        original_ocr = getattr(main, "init_ocr", None)
        original_static = getattr(main, "init_static_config", None)
        timer = threading.Timer(
            timeout_seconds,
            lambda: fail("Preparing Android script resources timed out; retry setup and inspect the startup log"),
        )
        timer.daemon = True

        def init_ocr(*ocr_args, **ocr_kwargs):
            progress("ocr", "Preparing the OCR runtime and required recognition models.")
            result = original_ocr(*ocr_args, **ocr_kwargs)
            if result is False or getattr(main, "ocr", None) is None:
                raise RuntimeError("Android OCR initialization failed; inspect the OCR startup log and retry setup")
            ocr = main.ocr
            if getattr(ocr, "client", None) is None or not callable(getattr(ocr, "test_models", None)):
                raise RuntimeError("The Android OCR client does not support model verification")
            validate_ocr_assets(ocr.client)
            languages = list(dict.fromkeys(["en-us", "zh-cn"] + list(getattr(main, "ocr_needed", None) or [])))
            ocr.test_models(languages)
            with lock:
                check_active()
                state["ocr"] = True
                report("ocr", "done", "OCR server and recognition models passed their startup probes.", "")
            return result

        def init_static(*static_args, **static_kwargs):
            progress("resources", "Checking the script configuration, RGB catalogs and image resources.")
            result = original_static(*static_args, **static_kwargs)
            if result is False:
                raise RuntimeError("Android script static configuration initialization failed")
            validate_resources(runtime._project_root)
            with lock:
                check_active()
                state["static"] = True
            return result

        try:
            progress("resources", "Preparing shared script resources before opening the application.")
            if not callable(original_ocr) or not callable(original_static):
                raise RuntimeError("The backend does not expose the required Android resource initializer")
            main.init_ocr = init_ocr
            main.init_static_config = init_static
            timer.start()
            result = original(runtime, *args, **kwargs)
            with lock:
                check_active()
                if not state["ocr"] or not state["static"] or not runtime.is_all_data_initialized:
                    raise RuntimeError("The backend did not finish preparing the required Android script resources")
                runtime._android_resources_ready = True
                report("resources", "done", "All shared Android script resources are ready.", "")
                state["finished"] = True
            return result
        except Exception as error:
            runtime.is_all_data_initialized = False
            runtime._android_resources_ready = False
            fail(error, traceback.format_exc())
            raise
        finally:
            timer.cancel()
            if main is not None:
                main.init_ocr = original_ocr
                main.init_static_config = original_static

    runtime_class.init_all_data = initialize
    runtime_class._android_resource_readiness_installed = True
