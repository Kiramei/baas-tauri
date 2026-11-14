"""Keep invalid profiles editable without aborting shared Android OCR startup."""

import functools
import json
import logging
from pathlib import Path


def validate_profile_server(root, config_id, resolve_server):
    config_root = (Path(root) / "config").resolve()
    directory = (config_root / config_id).resolve()
    if directory.parent != config_root or directory.name != config_id:
        raise RuntimeError("Invalid profile directory identifier")
    config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
    if not isinstance(config, dict) or not isinstance(config.get("server"), str) or not resolve_server(config["server"]):
        raise RuntimeError("Profile " + config_id + " has an unsupported server; choose a supported server in Configuration and retry")


def prepare_profiles(root, initializer, resolve_server, errors):
    """Leave invalid server profiles untouched while preparing valid profiles."""
    config_root = Path(root) / "config"
    config_root.mkdir(exist_ok=True)
    errors.clear()
    ready = []
    for directory in sorted(config_root.iterdir()):
        if not directory.is_dir():
            continue
        config_id = directory.name
        if not (directory / "config.json").is_file():
            if config_id == "default_config":
                raise RuntimeError("The default profile template is incomplete; config.json is missing")
            continue
        try:
            validate_profile_server(root, config_id, resolve_server)
            initializer.check_config(config_id)
            ready.append(config_id)
        except Exception as error:
            if config_id == "default_config":
                raise RuntimeError("The default profile template could not be initialized: " + str(error)) from error
            errors[config_id] = str(error)
            logging.getLogger(__name__).error("Profile %s was kept for repair without blocking shared resources: %s", config_id, error)
    if not ready:
        initializer.check_config("default_config")
        validate_profile_server(root, "default_config", resolve_server)


def install_profile_isolation(runtime_class, initializer_factory=None, resolve_server=None):
    """Revalidate on each session request; repairing a profile needs no blacklist reset."""
    if getattr(runtime_class, "_android_profile_isolation_installed", False):
        return
    def initializer(root):
        if initializer_factory is not None:
            return initializer_factory(root)
        from service.conf.initializer import ConfigInitializer
        return ConfigInitializer(root)

    def resolve(value):
        if resolve_server is not None:
            return resolve_server(value)
        from core.config.config_set import ConfigSet
        return ConfigSet.get_server_mode(value)
    original_session = runtime_class._get_or_create_session

    def checked_server(runtime, config_id):
        errors = getattr(runtime, "_android_profile_errors", None)
        if errors is None:
            errors = runtime._android_profile_errors = {}
        try:
            validate_profile_server(runtime._project_root, config_id, resolve)
        except Exception as error:
            errors[config_id] = str(error)
            raise
        return errors

    def ensure_config(runtime):
        errors = {}
        runtime._android_profile_errors = errors
        prepare_profiles(runtime._project_root, initializer(runtime._project_root), resolve, errors)

    @functools.wraps(original_session)
    def get_session(runtime, config_id):
        errors = checked_server(runtime, config_id)
        if config_id in errors and config_id not in runtime._sessions:
            initializer(runtime._project_root).check_config(config_id)
        result = original_session(runtime, config_id)
        errors.pop(config_id, None)
        return result

    runtime_class._ensure_config = ensure_config
    runtime_class._get_or_create_session = get_session

    def guard_async(original):
        @functools.wraps(original)
        async def checked(runtime, config_id, *args, **kwargs):
            # Existing sessions otherwise bypass _get_or_create_session.
            errors = checked_server(runtime, config_id)
            result = await original(runtime, config_id, *args, **kwargs)
            errors.pop(config_id, None)
            return result
        return checked

    for name in ("get_session", "start_scheduler", "solve_task"):
        original = getattr(runtime_class, name, None)
        if original is not None:
            setattr(runtime_class, name, guard_async(original))
    runtime_class._android_profile_isolation_installed = True
