"""Execute the same release action code with fixtures and a network-free sender."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


class ReleaseContracts(unittest.TestCase):
    def test_qq_uses_actual_release_body_and_authenticated_payload(self):
        text = (ROOT / ".github/actions/notify-qq/action.yml").read_text()
        # Test the action's embedded interpreter input, without invoking gh or the webhook.
        source = text.split("<<'PY'\n", 1)[1].rsplit("\n        PY", 1)[0]
        import textwrap
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp,"release.json")
            release = {"tag_name":"v1.2.3","body":"fixture notes"}
            path.write_text(json.dumps(release))
            with patch.dict(os.environ, QQ_WEBHOOK_SECRET="fixture", REPOSITORY="example/project"), \
                    patch("sys.argv", ["fixture",str(path)]), patch.object(urllib.request, "urlopen") as send:
                send.return_value.__enter__.return_value.status = 202
                exec(compile(textwrap.dedent(source),"<notify-qq fixture>","exec"),{})
                req = send.call_args.args[0]
                self.assertEqual(json.loads(req.data)["release"],release)
                self.assertEqual(req.get_header("X-hub-signature-256"),
                                 "sha256="+hmac.new(b"fixture",req.data,hashlib.sha256).hexdigest())

    def test_release_asset_validation_and_monotonic_promotion(self):
        def call(args, data):
            return subprocess.run(["node","scripts/ci/release-contract.mjs",*args],
                                  cwd=ROOT,input=json.dumps(data),text=True,capture_output=True)
        for tag, expected in [("1.2.3","false"), ("1.2.4.rc1","false"), ("1.2.3.post2","true")]:
            result=call(["promote",tag],[[{"tag_name":"1.2.3.post1"}]])
            self.assertEqual((result.returncode,result.stdout.strip()),(0,expected))
        for kind in ["app","updater","baasx"]:
            self.assertNotEqual(call(["verify",kind,"v1.2.3"],{"assets":[]}).returncode,0)
        good=["SHA256SUMS"]+[f"baasx-1.2.3-{platform}{ext}" for platform in
              ("Linux-X64","macOS-ARM64","Windows-X64") for ext in ("-bun.tgz",".tar.gz")]
        self.assertEqual(call(["verify","baasx","baasx-v1.2.3"],
                              {"assets":[{"name":s} for s in good]}).returncode,0)

    def test_cnb_wait_ready_only_fails_before_polling(self):
        import textwrap
        action=(ROOT/".github/actions/sync-cnb-release/action.yml").read_text()
        source=action.split("    - name: Wait for GitHub release\n",1)[1].split("    - name:",1)[0]
        script=textwrap.dedent(source.split("      run: |\n",1)[1])
        with tempfile.TemporaryDirectory() as tmp:
            for name,body in [("gh","exit 1"),("sleep","touch \"$MARKER\"; exit 77")]:
                executable=Path(tmp,name); executable.write_text("#!/bin/sh\n"+body+"\n"); executable.chmod(0o755)
            env={**os.environ,"PATH":tmp+os.pathsep+os.environ["PATH"], "WAIT_TIMEOUT_MINUTES":"0",
                 "TAG_NAME":"v1.2.3","MINIMUM_ASSETS":"1","POLL_INTERVAL_SECONDS":"60","MARKER":tmp+"/slept"}
            result=subprocess.run(["bash","-c",script],cwd=tmp,env=env,capture_output=True)
            self.assertEqual(result.returncode,1)
            self.assertFalse(Path(env["MARKER"]).exists())
