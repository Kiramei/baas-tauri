import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JAVA = ROOT / "src-tauri/gen/android/app/src/main/java/io/github/kiramei/baas_tauri"


class AndroidBackendLifecycleTest(unittest.TestCase):
    def test_only_foreground_service_calls_python_bootstrap(self):
        callers = [path.name for path in JAVA.glob("*.kt")
                   if re.search(r"BaasBackend\s*\.\s*ensureStarted\s*\(", path.read_text(encoding="utf-8"))]
        self.assertEqual(callers, ["BaasForegroundService.kt"])

    def test_process_guard_precedes_process_local_singleton(self):
        source = (JAVA / "BaasBackend.kt").read_text(encoding="utf-8")
        self.assertIn('processName != "${appContext.packageName}:baas_backend"', source)
        self.assertLess(source.index("Refusing Python bootstrap"), source.index("started.compareAndSet"))
        manifest = (ROOT / "src-tauri/gen/android/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
        self.assertRegex(manifest, r'<service\s+android:name="\.BaasForegroundService"[^>]*android:process=":baas_backend"')


if __name__ == "__main__":
    unittest.main()
