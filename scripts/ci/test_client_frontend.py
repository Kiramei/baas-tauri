import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/ci/client-frontend.mjs"


class ClientPlan(unittest.TestCase):
    def invoke(self, modes, bundles, adapters):
        env = {**os.environ, "MODES": json.dumps(modes), "BUNDLES": str(bundles).lower(), "ADAPTERS": json.dumps(adapters)}
        return subprocess.run(["bun", str(SCRIPT), "validate"], cwd=ROOT, env=env, capture_output=True, text=True)

    def test_consistent_client_and_adapter_selection(self):
        matrix = {"include": [{"mode": "windows", "os": "windows-latest"}, {"mode": "macos", "os": "macos-latest"}]}
        result = self.invoke(["android", "windows", "macos"], True, matrix)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_os_only_does_not_need_client_bundle(self):
        result = self.invoke(["linux"], False, {"include": [{"mode": "linux", "os": "ubuntu-24.04"}]})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_invalid_and_disagreeing_plans(self):
        linux = {"include": [{"mode": "linux", "os": "ubuntu-24.04"}]}
        cases = [([], False, {"include": []}), (["webui", "webui"], True, {"include": []}),
                 (["unknown"], True, {"include": []}), ([1], False, {"include": []}),
                 ("webui", True, {"include": []}), (["linux"], True, linux),
                 (["linux"], False, {"include": []}), (["linux"], False, {"include": [{"mode": "linux", "os": "self-hosted"}]}),
                 (["linux"], False, {**linux, "extra": ["x"]})]
        for modes, bundles, adapters in cases:
            with self.subTest(modes=modes, bundles=bundles, adapters=adapters):
                self.assertNotEqual(self.invoke(modes, bundles, adapters).returncode, 0)


if __name__ == "__main__":
    unittest.main()
