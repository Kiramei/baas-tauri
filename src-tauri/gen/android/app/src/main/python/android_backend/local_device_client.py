"""Shared backend compatibility names backed by BAAS's local Shizuku bridge.

`uiautomator2` resolves to bootstrap's generated local RPC adapter, not the
third-party package. No UIAutomator agent or APK is installed by this module.
"""
import uiautomator2 as local_bridge
from uiautomator2.version import __apk_version__, __atx_agent_version__, __version__


class U2Client:
    connections = {}

    def __init__(self, serial):
        self.serial = serial
        self.connection = local_bridge.connect(serial)

    @staticmethod
    def get_instance(serial):
        if serial not in U2Client.connections:
            U2Client.connections[serial] = U2Client(serial)
        return U2Client.connections[serial]

    @staticmethod
    def release_instance(serial):
        U2Client.connections.pop(serial, None)

    def click(self, x, y):
        return self.connection.click(x, y)

    def swipe(self, x1, y1, x2, y2, duration):
        return self.connection.swipe(x1, y1, x2, y2, duration)

    def screenshot(self):
        import numpy as np
        return np.asarray(self.connection.screenshot().convert("RGB"))[:, :, ::-1].copy()

    def get_connection(self):
        return self.connection


class BAAS_U2_Initer:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("UIAutomator agents are not used on Android; use the Shizuku bridge")
