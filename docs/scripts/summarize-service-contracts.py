"""Publish counts and pinned test-source hashes, excluding private JUnit diagnostics."""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from xml.etree import ElementTree


root = Path(__file__).resolve().parents[2]
repo, snapshot, junit = map(lambda value: Path(value).resolve(), sys.argv[1:4])
assert snapshot.is_relative_to(root / ".cache") and junit.is_relative_to(root / ".cache")
revision = "d0a86a089068766ff53682b501b90bee99857a71"
files = [f"tests/service/{name}.py" for name in (
    "test_auth_manager", "test_security_contract", "test_http_contract", "test_ws_behaviors",
    "test_ws_sync_conflict", "test_pipe_transport", "test_shm_transport",
)]
sha = lambda data: hashlib.sha256(data).hexdigest()
sources = []
for file in files:
    data = (snapshot / file).read_bytes().replace(b"\r\n", b"\n")
    blob = subprocess.check_output(["git", "-C", str(repo), "show", f"{revision}:{file}"]).replace(b"\r\n", b"\n")
    assert data == blob, f"Test source drift: {file}"
    sources.append({"file": file, "sha256": sha(data), "gitContentVerified": True})
cases = list(ElementTree.parse(junit).getroot().iter("testcase"))
failed = [case for case in cases if case.find("failure") is not None or case.find("error") is not None]
skipped = [{"test": case.attrib["name"], "reason": case.find("skipped").attrib.get("message", "")}
           for case in cases if case.find("skipped") is not None]
assert len(cases) == 44 and not failed and len(skipped) == 1
assert skipped[0]["reason"] == "Unix sockets are unavailable on Windows"
cli_sources = []
for file in ("main.service.py", "cli.example.py", "pyproject.toml"):
    data = (snapshot / file).read_bytes().replace(b"\r\n", b"\n")
    blob = subprocess.check_output(["git", "-C", str(repo), "show", f"{revision}:{file}"]).replace(b"\r\n", b"\n")
    assert data == blob
    cli_sources.append({"file": file, "sha256": sha(data), "gitContentVerified": True})
cli_cache = root / ".cache" / "service-protocol" / "cli-help"
cli_cache.mkdir(exist_ok=True)
environment = {key: value for key, value in os.environ.items() if not key.startswith("BAAS_") and key not in {"PYTHONHOME", "PYTHONPATH"}}
help_result = subprocess.run([sys.executable, str(snapshot / "main.service.py"), "--help"], cwd=cli_cache, env=environment,
                             capture_output=True, timeout=15)
assert help_result.returncode == 0
options = ["--host", "--port", "--reload", "--log-level", "--pipe-name", "--shm-name", "--ocr-update-check", "--no-ocr-update-check"]
for option in options:
    assert option.encode() in help_result.stdout
conflict = subprocess.run([sys.executable, str(snapshot / "main.service.py"), "--pipe-name", "docs-contract-pipe", "--shm-name", "docs-contract-shm"],
                          cwd=cli_cache, env=environment, capture_output=True, timeout=15)
assert conflict.returncode == 2 and b"not allowed with argument" in conflict.stderr
assert not (cli_cache / ".pid").exists()
(cli_cache / "help-stdout.txt").write_bytes(help_result.stdout)
(cli_cache / "conflict-stderr.txt").write_bytes(conflict.stderr)
report = {
    "checkedAt": datetime.now(timezone.utc).isoformat(),
    "backendRevision": revision,
    "publisherSha256": sha(Path(__file__).read_bytes().replace(b"\r\n", b"\n")),
    "junitSha256": sha(junit.read_bytes()),
    "collected": len(cases), "passed": len(cases) - len(skipped), "failed": len(failed), "skipped": skipped,
    "testSources": sources,
    "cliSources": cli_sources,
    "cli": {"helpExitCode": 0, "helpOutputSha256": sha(help_result.stdout), "supportedOptions": options,
            "mutuallyExclusiveExitCode": 2, "noPidFileAfterCheck": True,
            "scope": "Only --help and mutually exclusive option rejection were executed in a separate ignored working directory. Startup logging/exit cleanup ran; no Service server or legacy CLI game tasks were started."},
    "scope": "Existing backend contract tests in a disposable Git snapshot using the available Python environment. Several tests use deterministic adapters or reduced KDFs; actual cross-language crypto is recorded separately in service-protocol-validation.json. No full service runtime, device, game, TLS deployment or fresh dependency installation is validated.",
}
(root / "docs/evidence/service-contract-tests.json").write_bytes((json.dumps(report, indent=2) + "\n").encode("utf-8"))
print(json.dumps({"collected": report["collected"], "passed": report["passed"], "skipped": len(skipped)}))
