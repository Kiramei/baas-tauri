import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

import numpy as np

spec = importlib.util.spec_from_file_location("measure_device", Path(__file__).resolve().parents[1] / "scripts/measure-device.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(values=(54321, 42, 61000, 300)):
    image = np.full((720, 1280, 3), 235, dtype=np.uint8)
    image[20:44, 20:44] = [255, 0, 255]
    for x, color in zip([100, 160, 220], [[0, 0, 255], [0, 255, 0], [255, 0, 0]]):
        image[20:44, x:x + 24] = color
    for top, value in zip([85, 145, 205, 265], values):
        for bit in range(16):
            x = 32 + bit * 72
            image[top:top + 40, x:x + 48] = 245 if value & (1 << bit) else 24
    return image


class NativeTargetTest(unittest.TestCase):
    def test_direct_http_uses_the_owned_adb_socket_and_closes_it(self):
        device = MagicMock()
        client = MagicMock()
        response = client.getresponse.return_value
        response.status = 200
        response.getheaders.return_value = [("Content-Type", "text/plain")]
        response.read.return_value = b"0.10.0"
        with patch.object(module, "HTTPConnection", return_value=client):
            self.assertEqual(module.http(device, "/version"), (200, {"Content-Type": "text/plain"}, b"0.10.0"))
        self.assertIs(client.sock, device.create_connection.return_value)
        client.request.assert_called_once_with("GET", "/version")
        client.close.assert_called_once()

    def test_foreground_and_agent_identity_fail_closed(self):
        device = MagicMock()
        device.shell.return_value = "topResumedActivity=ActivityRecord{abc u0 " + module.TARGET + "/.MainActivity t3}"
        self.assertEqual(module.foreground(device), module.TARGET)
        device.shell.return_value *= 2
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            module.foreground(device)
        device.shell.return_value = module.AGENT
        self.assertTrue(module.is_owned_agent(device, 10, "baas-docs-atx-agent server --nouia"))
        device.shell.return_value = "/data/local/tmp/another-agent"
        self.assertFalse(module.is_owned_agent(device, 10, "baas-docs-atx-agent server --nouia"))
        self.assertFalse(module.is_owned_agent(device, 10, "another-agent server"))

    def test_observer_matches_the_input_counter_and_retains_first_detection(self):
        client = MagicMock()
        client.last_frame = fixture((12, 0, 10, 0))
        observer = module.FrameObserver(client)
        try:
            observer.wait(12, 0)
            client.last_frame = fixture((12, 1, 11, 300))
            first = observer.wait(12, 1)
            self.assertEqual(first[1]["durationMs"], 300)
            client.last_frame = fixture((12, 1, 12, 300))
            self.assertEqual(observer.wait(12, 1)[0], first[0])
            with self.assertRaisesRegex(ValueError, "not-observed"):
                observer.wait(13, 0, timeout=0.01)
        finally:
            observer.close()

    def test_all_barcodes_and_channel_order(self):
        image = fixture()
        result = module.decode_frame(image, 54321)
        self.assertEqual([result[key] for key in ["token", "inputs", "frame", "durationMs"]], [54321, 42, 61000, 300])
        self.assertEqual(result["channelOrder"], "BGR")
        self.assertEqual(module.decode_frame(image[:, :, ::-1])["channelOrder"], "RGB")

    def test_invalid_missing_stale_and_ambiguous_frames(self):
        for image in [None, np.zeros((720, 1280, 3), dtype=np.uint8), fixture()[:500], fixture().astype(np.float32)]:
            with self.assertRaises(ValueError):
                module.decode_frame(image)
        with self.assertRaisesRegex(ValueError, "stale"):
            module.decode_frame(fixture(), 10)
        image = fixture()
        image[85:125, 32:80] = 128
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            module.decode_frame(image)

    def test_counter_wrap_and_order_balance(self):
        self.assertEqual(module.decode_frame(fixture((0, 65535, 0, 65535)))["durationMs"], 65535)
        self.assertEqual(sorted(sum(([tuple(order[index:index + 2]) for index in range(3)] for order in module.ORDERS), [])),
                         sorted((a, b) for a in range(4) for b in range(4) if a != b))
        for position in range(4):
            self.assertEqual(sorted(order[position] for order in module.ORDERS), list(range(4)))


if __name__ == "__main__":
    unittest.main()
