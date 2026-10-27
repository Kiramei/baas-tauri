"""Import-only names for dormant desktop ADB adapters; no ADB implementation.

The shared backend eagerly imports desktop device classes before Android's
native adapters are selected. Keep their type/exception names importable, but
fail explicitly if a legacy transport is accidentally selected.
"""
from enum import Enum


class AdbError(RuntimeError):
    pass


class AdbTimeout(AdbError):
    pass


class AdbDevice:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("ADB is not packaged on Android; use android_local")


AdbConnection = AdbDevice
ForwardItem = AdbDevice


class Network(Enum):
    TCP = "tcp"
    LOCAL_ABSTRACT = "localabstract"


class _UnavailableAdb:
    def __getattr__(self, name):
        raise RuntimeError("ADB is not packaged on Android; use android_local")


adb = _UnavailableAdb()
adb_path = None
