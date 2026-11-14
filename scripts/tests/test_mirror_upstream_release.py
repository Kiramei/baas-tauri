"""Run the production mirror client against an entirely in-memory GitHub API."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import Request


SCRIPT = Path(__file__).resolve().parents[1] / "mirror-upstream-release.py"
SPEC = importlib.util.spec_from_file_location("mirror_upstream_release", SCRIPT)
mirror = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mirror
SPEC.loader.exec_module(mirror)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Response(io.BytesIO):
    def __init__(self, body, headers=None):
        super().__init__(body)
        self.headers = headers or {"Content-Length": str(len(body))}
        self.status = 200


class FakeGitHub:
    source = "example/client"
    target = "upstream/backend"

    def __init__(self):
        self.releases = {self.source: {"id": 1, "tag_name": "v1.2.3", "draft": False,
            "prerelease": False, "name": "App 1.2.3", "body": "Published release notes", "updated_at": "stable"}}
        self.assets = {self.source: [], self.target: []}
        self.content = {}
        self.events, self.downloads, self.sleeps = [], [], []
        self.failures = {}
        self.next_id = 10
        self.existing_tag = False
        self.on_source_list = None
        self.source_lists = 0
        self.hidden_drafts_by_tag = False
        self.hidden_drafts_by_list = False
        self.target_tag_gets = 0
        self.on_target_tag_get = None

    def asset(self, repo, name, data, *, digest=True, label="", state="uploaded"):
        asset = {"id": self.next_id, "name": name, "label": label, "state": state,
                 "size": len(data), "digest": "sha256:" + sha(data) if digest else None,
                 "updated_at": f"asset-{self.next_id}", "content_type": "application/octet-stream"}
        self.next_id += 1
        self.assets[repo].append(asset)
        self.content[repo, asset["id"]] = data
        return asset

    def failure(self, method, route, status, *, headers=None):
        self.failures.setdefault((method, route), []).append(
            HTTPError("https://api.github.com" + route, status, "fixture", headers or {}, io.BytesIO(b'{"message":"fixture"}')))

    def clients(self, dry_run=False):
        options = {"opener": self, "sleep": self.sleeps.append}
        return (mirror.GitHub(self.source, "source-fixture", read_only=True, **options),
                mirror.GitHub(self.target, "" if dry_run else "target-fixture", read_only=dry_run, **options))

    def run(self, **options):
        source, target = self.clients(options.get("dry_run", False))
        # Transport/transaction fixtures exercise arbitrary names independently
        # of the production installer policy, which has dedicated tests below.
        options.setdefault("select_assets", lambda assets, version: assets)
        return mirror.Mirror(source, target, "v1.2.3", sleep=self.sleeps.append, **options).run()

    def owned_release(self, *, draft=False):
        source, target = self.clients()
        runner = mirror.Mirror(source, target, "v1.2.3")
        body = runner.marker + "\nMirror of [example/client v1.2.3](https://github.com/example/client/releases/tag/v1.2.3).\n\n" + (
            "The mirror tag points to the target repository's own commit, not the Tauri source commit. "
            "Use the source release above for Tauri source and history.\n\nPublished release notes")
        self.releases[self.target] = {"id": 2, "tag_name": runner.target_tag, "name": "App 1.2.3",
            "body": body, "draft": draft, "prerelease": True, "make_latest": "false"}
        self.existing_tag = True
        return runner

    def json(self, value):
        return Response(json.dumps(value).encode())

    def open(self, request, timeout=60):
        method, url = request.get_method(), urlsplit(request.full_url)
        route = unquote(url.path)
        parts = route.split("/")
        repo = "/".join(parts[2:4])
        relative = "/" + "/".join(parts[4:]) if len(parts) > 4 else ""
        payload = request.data
        if hasattr(payload, "read"):
            payload = payload.read()
        if payload and request.get_header("Content-type") == "application/json":
            payload = json.loads(payload)
        event = {"method": method, "repo": repo, "route": relative, "payload": payload,
                 "authorization": request.get_header("Authorization"), "host": url.netloc,
                 "cache-control": request.get_header("Cache-control")}
        self.events.append(event)
        expected = "Bearer source-fixture" if repo == self.source else "Bearer target-fixture"
        if event["authorization"] not in (expected, None):
            raise AssertionError("A token crossed repository boundaries")
        if repo == self.source and method != "GET":
            raise AssertionError("Source token attempted a write")
        queued = self.failures.get((method, relative), [])
        if queued:
            failure = queued.pop(0)
            if callable(failure):
                return failure(request, event)
            raise failure
        if relative == "" and method == "GET":
            return self.json({"default_branch": "master"})
        if relative == "/branches/master" and method == "GET":
            return self.json({"commit": {"sha": "a" * 40}})
        if relative.startswith("/git/ref/tags/") and method == "GET":
            if self.existing_tag:
                return self.json({"object": {"sha": "a" * 40}})
            raise HTTPError(request.full_url, 404, "not found", {}, io.BytesIO())
        if relative.startswith("/releases/tags/") and method == "GET":
            if repo == self.target:
                self.target_tag_gets += 1
                if self.on_target_tag_get:
                    self.on_target_tag_get(self)
            release = self.releases.get(repo)
            if release and release["tag_name"] == relative.removeprefix("/releases/tags/") and not (repo == self.target and release["draft"] and self.hidden_drafts_by_tag):
                return self.json(release)
            raise HTTPError(request.full_url, 404, "not found", {}, io.BytesIO())
        if relative == "/releases" and method == "GET":
            page = int(parse_qs(url.query).get("page", ["1"])[0])
            releases = [self.releases[repo]] if repo in self.releases else []
            if repo == self.target and self.hidden_drafts_by_list:
                releases = [release for release in releases if not release["draft"]]
            return self.json(releases[(page - 1) * 100:page * 100])
        if relative == "/releases" and method == "POST":
            if repo in self.releases:
                raise HTTPError(request.full_url, 422, "exists", {}, io.BytesIO())
            self.releases[repo] = {"id": 2, **payload}
            self.existing_tag = True
            return self.json(self.releases[repo])
        if relative == "/releases/2" and method == "PATCH":
            self.releases[repo].update(payload)
            return self.json(self.releases[repo])
        if relative == "/releases/2" and method == "GET":
            release = self.releases.get(repo)
            if release and release["id"] == 2:
                return self.json(release)
            raise HTTPError(request.full_url, 404, "not found", {}, io.BytesIO())
        if len(parts) == 7 and parts[-1] == "assets":
            if method == "GET":
                if repo == self.source:
                    self.source_lists += 1
                    if self.on_source_list:
                        self.on_source_list(self)
                page = int(parse_qs(url.query).get("page", ["1"])[0])
                return self.json(self.assets[repo][(page - 1) * 100:page * 100])
            if method == "POST":
                query = parse_qs(url.query, keep_blank_values=True)
                name, label = query["name"][0], query["label"][0]
                if any(asset["name"] == name for asset in self.assets[repo]):
                    raise HTTPError(request.full_url, 422, "exists", {}, io.BytesIO())
                return self.json(self.asset(repo, name, payload, label=label))
        if relative.startswith("/releases/assets/"):
            asset_id = int(relative.rsplit("/", 1)[1])
            asset = next((asset for asset in self.assets[repo] if asset["id"] == asset_id), None)
            if not asset:
                raise HTTPError(request.full_url, 404, "not found", {}, io.BytesIO())
            if method == "GET":
                self.downloads.append((repo, asset_id))
                return Response(self.content[repo, asset_id])
            if method == "PATCH":
                if any(other["id"] != asset_id and other["name"] == payload["name"] for other in self.assets[repo]):
                    raise HTTPError(request.full_url, 422, "exists", {}, io.BytesIO())
                asset.update(payload)
                return self.json(asset)
            if method == "DELETE":
                self.assets[repo].remove(asset)
                return Response(b"")
        raise AssertionError(f"Unexpected fixture request: {method} {request.full_url}")


class MirrorTests(unittest.TestCase):
    def test_complete_first_publish_uses_target_branch_and_keeps_names_and_bytes(self):
        fake = FakeGitHub()
        data = {"应用.apk": b"\x00android\xff", "app.zip.sig": b"signature\n", "SHA256SUMS": b"checksums"}
        for name, value in data.items():
            fake.asset(fake.source, name, value)
        result = fake.run()
        self.assertEqual((result["status"], result["target-tag"], result["uploaded"]), ("synced", "tauri-1.2.3", 3))
        self.assertEqual({asset["name"]: fake.content[fake.target, asset["id"]] for asset in fake.assets[fake.target]}, data)
        created = next(event["payload"] for event in fake.events if event["method"] == "POST" and event["route"] == "/releases")
        self.assertTrue(created["draft"])
        self.assertTrue(created["prerelease"])
        self.assertIn("Published release notes", created["body"])
        self.assertIn("not the Tauri source commit", created["body"])
        self.assertEqual(created["name"], "App 1.2.3")
        self.assertEqual(created["target_commitish"], "a" * 40)
        published = [event["payload"] for event in fake.events if event["method"] == "PATCH" and event["route"] == "/releases/2"][-1]
        self.assertEqual(published, {"draft": False, "prerelease": True, "make_latest": "false"})
        self.assertEqual(fake.releases[fake.target]["prerelease"], True)
        self.assertFalse(any(event["route"].startswith("/git/") and event["method"] != "GET" for event in fake.events))

    def test_idempotent_server_digests_skip_all_binary_downloads_and_metadata_edits(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"original")
        fake.asset(fake.target, "app.zip", b"original")
        fake.owned_release()
        result = fake.run()
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(fake.downloads, [])
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_missing_digests_hash_actual_bytes_and_still_skip_unchanged_assets(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"original", digest=False)
        fake.asset(fake.target, "app.zip", b"original", digest=False)
        fake.owned_release()
        result = fake.run()
        self.assertEqual(result["skipped"], 1)
        self.assertEqual(len(fake.downloads), 2)
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))
        self.assertEqual(result["assets"][0]["sha256"], sha(b"original"))

    def test_missing_assets_are_added_without_resending_existing_assets(self):
        fake = FakeGitHub()
        old = fake.asset(fake.source, "old.zip", b"old")
        new = fake.asset(fake.source, "new.zip", b"new")
        fake.asset(fake.target, "old.zip", b"old")
        fake.owned_release()
        result = fake.run()
        self.assertEqual((result["skipped"], result["uploaded"]), (1, 1))
        self.assertEqual(fake.downloads, [(fake.source, new["id"])])
        self.assertNotIn((fake.source, old["id"]), fake.downloads)
        first_write = next(event for event in fake.events if event["method"] != "GET")
        self.assertEqual((first_write["route"], first_write["payload"]["draft"]), ("/releases/2", True))

    def test_safe_replacement_deletes_backup_only_after_verified_promotion(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new bytes")
        old = fake.asset(fake.target, "app.zip", b"old bytes")
        fake.owned_release()
        result = fake.run()
        self.assertEqual(result["replaced"], 1)
        writes = [event for event in fake.events if event["method"] != "GET"]
        deleted = next(index for index, event in enumerate(writes) if event["method"] == "DELETE")
        promoted = next(index for index, event in enumerate(writes) if event["method"] == "PATCH" and event["payload"].get("name") == "app.zip")
        self.assertGreater(deleted, promoted)
        self.assertEqual(writes[deleted]["route"], f"/releases/assets/{old['id']}")
        self.assertEqual(fake.content[fake.target, fake.assets[fake.target][0]["id"]], b"new bytes")

    def test_failed_promotion_restores_old_name_and_rerun_reuses_verified_stage(self):
        fake = FakeGitHub()
        source = fake.asset(fake.source, "app.zip", b"new")
        old = fake.asset(fake.target, "app.zip", b"old")
        fake.owned_release()
        stage_id = fake.next_id
        fake.failure("PATCH", f"/releases/assets/{stage_id}", 403)
        with self.assertRaises(mirror.APIError):
            fake.run()
        self.assertEqual(next(asset for asset in fake.assets[fake.target] if asset["id"] == old["id"])["name"], "app.zip")
        self.assertTrue(fake.releases[fake.target]["draft"])
        first_download_count = len(fake.downloads)
        self.assertEqual(fake.downloads, [(fake.source, source["id"])])
        result = fake.run()
        self.assertEqual(result["replaced"], 1)
        self.assertEqual(len(fake.downloads), first_download_count)
        self.assertEqual([asset["name"] for asset in fake.assets[fake.target]], ["app.zip"])

    def test_interrupted_backup_and_stage_are_completed_without_redownload(self):
        fake = FakeGitHub()
        source = fake.asset(fake.source, "app.zip", b"new")
        runner = fake.owned_release(draft=True)
        fingerprint = sha(b"new")
        fake.asset(fake.target, f"__baas_tauri_mirror_{source['id']}_99.backup", b"old", label=runner.working_label(source, fingerprint))
        fake.asset(fake.target, f"__baas_tauri_mirror_{source['id']}_{fingerprint}.stage", b"new", label=runner.working_label(source, fingerprint))
        fake.run()
        self.assertEqual(fake.downloads, [])
        self.assertEqual([asset["name"] for asset in fake.assets[fake.target]], ["app.zip"])

    def test_corrupt_upload_never_deletes_or_renames_the_existing_canonical_asset(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        old = fake.asset(fake.target, "app.zip", b"old")
        fake.owned_release()
        def corrupt(request, event):
            query = parse_qs(urlsplit(request.full_url).query)
            return fake.json(fake.asset(fake.target, query["name"][0], b"bad", label=query["label"][0]))
        fake.failures["POST", "/releases/2/assets"] = [corrupt]
        with self.assertRaisesRegex(mirror.MirrorError, "staging asset failed"):
            fake.run()
        self.assertEqual(old["name"], "app.zip")
        self.assertFalse(any(event["method"] in ("PATCH", "DELETE") and event["route"] == f"/releases/assets/{old['id']}" for event in fake.events))

    def test_failed_source_download_never_uploads_a_partial_file(self):
        fake = FakeGitHub()
        asset = fake.asset(fake.source, "app.zip", b"new")
        fake.failures["GET", f"/releases/assets/{asset['id']}"] = [URLError("source unavailable") for _ in range(5)]
        with self.assertRaises(mirror.NetworkError):
            fake.run()
        self.assertFalse(any(event["method"] == "POST" and event["route"].endswith("/assets") for event in fake.events))
        self.assertTrue(fake.releases[fake.target]["draft"])

    def test_ambiguous_successful_upload_reconciles_the_existing_stage(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        def lost_response(request, event):
            query = parse_qs(urlsplit(request.full_url).query)
            fake.asset(fake.target, query["name"][0], event["payload"], label=query["label"][0])
            raise URLError("response lost")
        fake.failures["POST", "/releases/2/assets"] = [lost_response]
        fake.run()
        self.assertEqual([asset["name"] for asset in fake.assets[fake.target]], ["app.zip"])

    def test_successful_create_hidden_by_tag_and_list_uses_known_id_without_another_post(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        fake.hidden_drafts_by_tag = fake.hidden_drafts_by_list = True
        result = fake.run()
        self.assertEqual(result["uploaded"], 1)
        self.assertFalse(fake.releases[fake.target]["draft"])
        self.assertEqual(sum(event["method"] == "POST" and event["route"] == "/releases" for event in fake.events), 1)
        self.assertEqual(sum(event["method"] == "GET" and event["route"] == "/releases/2" for event in fake.events), 3)

    def test_known_id_temporarily_missing_after_successful_create_retries_only_get(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        fake.hidden_drafts_by_tag = fake.hidden_drafts_by_list = True
        fake.failure("GET", "/releases/2", 404)
        fake.run()
        self.assertEqual(fake.sleeps, [5, 1])
        creates = [index for index, event in enumerate(fake.events) if event["method"] == "POST" and event["route"] == "/releases"]
        self.assertEqual(len(creates), 1)
        following = fake.events[creates[0] + 1:]
        first_write = next(index for index, event in enumerate(following) if event["method"] != "GET")
        self.assertEqual(sum(event["route"] == "/releases/2" for event in following[:first_write]), 2)
        self.assertFalse(fake.releases[fake.target]["draft"])

    def test_stale_list_draft_does_not_override_fresh_published_release_by_id(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        fake.hidden_drafts_by_tag = True
        def stale_list(request, event):
            release = fake.releases.get(fake.target)
            return fake.json([{**release, "draft": True}] if release else [])
        fake.failures["GET", "/releases"] = [stale_list] * 4
        result = fake.run()
        self.assertEqual(result["uploaded"], 1)
        self.assertFalse(fake.releases[fake.target]["draft"])
        self.assertEqual(fake.failures["GET", "/releases"], [])

    def test_known_id_identity_and_marker_changes_fail_before_asset_writes(self):
        for field, value in (("id", 3), ("tag_name", "unrelated"), ("body", "Marker removed")):
            with self.subTest(field=field):
                fake = FakeGitHub()
                fake.asset(fake.source, "app.zip", b"new")
                def changed(request, event):
                    return fake.json({**fake.releases[fake.target], field: value})
                fake.failures["GET", "/releases/2"] = [changed]
                with self.assertRaises(mirror.MirrorError):
                    fake.run()
                self.assertEqual(sum(event["route"] == "/releases/2" for event in fake.events), 1)
                self.assertTrue(all(event["method"] == "GET" or event["route"] == "/releases" for event in fake.events))
                self.assertEqual(fake.assets[fake.target], [])

    def test_different_id_or_duplicate_tag_discovery_fails_before_asset_writes(self):
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate):
                fake = FakeGitHub()
                fake.asset(fake.source, "app.zip", b"new")
                fake.hidden_drafts_by_tag = True
                def conflicting_list(request, event):
                    release = fake.releases[fake.target]
                    return fake.json(([release] if duplicate else []) + [{**release, "id": 3}])
                fake.failures["GET", "/releases"] = [lambda *_: fake.json([]), conflicting_list]
                with self.assertRaises(mirror.MirrorError):
                    fake.run()
                self.assertTrue(all(event["method"] == "GET" or event["route"] == "/releases" for event in fake.events))
                self.assertEqual(fake.assets[fake.target], [])

    def test_successful_create_with_lost_transport_response_recovers_hidden_draft_without_another_post(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        fake.hidden_drafts_by_tag = True
        def created_then_disconnected(request, event):
            fake.releases[fake.target] = {"id": 2, **event["payload"]}
            fake.existing_tag = True
            raise URLError("lost creation response")
        fake.failures["POST", "/releases"] = [created_then_disconnected]
        fake.run()
        creates = [event for event in fake.events if event["method"] == "POST" and event["route"] == "/releases"]
        self.assertEqual(len(creates), 1)
        self.assertTrue(any(event["method"] == "GET" and event["repo"] == fake.target and event["route"] == "/releases" for event in fake.events))
        self.assertFalse(fake.releases[fake.target]["draft"])

    def test_unknown_create_result_only_reconciles_without_another_post(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        fake.failure("POST", "/releases", 502)
        with self.assertRaisesRegex(mirror.MirrorError, "creation result is uncertain"):
            fake.run()
        creates = [index for index, event in enumerate(fake.events) if event["method"] == "POST" and event["route"] == "/releases"]
        self.assertEqual(len(creates), 1)
        following = fake.events[creates[0] + 1:]
        self.assertEqual(sum(event["method"] == "GET" and event["route"] == "/releases" for event in following), 5)
        self.assertTrue(all(event["method"] == "GET" for event in following))

    def test_eventually_visible_create_recovers_after_backoff_without_a_duplicate_post(self):
        for failure in ("network", "gateway"):
            with self.subTest(failure=failure):
                fake = FakeGitHub()
                fake.asset(fake.source, "app.zip", b"new")
                def persist_but_hide(request, event):
                    pending = {"id": 2, **event["payload"]}
                    def become_visible(api):
                        if api.target_tag_gets >= 3:
                            api.releases[api.target] = pending
                    fake.on_target_tag_get = become_visible
                    fake.existing_tag = True
                    if failure == "network":
                        raise URLError("lost response")
                    raise HTTPError(request.full_url, 502, "gateway", {}, io.BytesIO())
                fake.failures["POST", "/releases"] = [persist_but_hide]
                result = fake.run()
                self.assertEqual(result["uploaded"], 1)
                creates = [event for event in fake.events if event["method"] == "POST" and event["route"] == "/releases"]
                self.assertEqual(len(creates), 1)
                self.assertIn(1, fake.sleeps)
                self.assertFalse(fake.releases[fake.target]["draft"])

    def test_invalid_creation_response_never_receives_asset_writes(self):
        for field, value in (("id", -1), ("tag_name", "unrelated"), ("body", "foreign"), ("draft", False), ("prerelease", False)):
            with self.subTest(field=field):
                fake = FakeGitHub()
                fake.asset(fake.source, "app.zip", b"new")
                def wrong_response(request, event):
                    return fake.json({"id": 2, **event["payload"], field: value})
                fake.failures["POST", "/releases"] = [wrong_response]
                with self.assertRaises(mirror.MirrorError):
                    fake.run()
                self.assertFalse(any(event["method"] != "GET" and event["route"] != "/releases" for event in fake.events))

    def test_final_marker_change_is_not_overwritten_or_published(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        def changed(api):
            if api.target_tag_gets == 3:
                api.releases[api.target]["body"] = "Marker removed by target owner"
        fake.on_target_tag_get = changed
        with self.assertRaisesRegex(mirror.MirrorError, "ownership"):
            fake.run()
        self.assertTrue(fake.releases[fake.target]["draft"])
        self.assertEqual(fake.releases[fake.target]["body"], "Marker removed by target owner")

    def test_changed_draft_metadata_with_marker_preserved_is_not_published(self):
        for field in ("name", "body"):
            with self.subTest(field=field):
                fake = FakeGitHub()
                fake.asset(fake.source, "app.zip", b"new")
                def changed(api):
                    if api.target_tag_gets == 3:
                        api.releases[api.target][field] += " edited during sync"
                fake.on_target_tag_get = changed
                with self.assertRaisesRegex(mirror.MirrorError, "metadata changed"):
                    fake.run()
                self.assertTrue(fake.releases[fake.target]["draft"])
                self.assertFalse(any(event["method"] == "PATCH" and event["route"] == "/releases/2" and event["payload"].get("draft") is False for event in fake.events))

    def test_foreign_release_unknown_assets_and_orphan_tag_are_never_overwritten(self):
        for conflict in ("marker", "asset", "tag"):
            with self.subTest(conflict=conflict):
                fake = FakeGitHub()
                fake.asset(fake.source, "app.zip", b"new")
                if conflict == "tag":
                    fake.existing_tag = True
                else:
                    fake.owned_release()
                    if conflict == "marker":
                        fake.releases[fake.target]["body"] = "Unrelated release"
                    else:
                        fake.asset(fake.target, "unknown.exe", b"keep me")
                with self.assertRaises(mirror.MirrorError):
                    fake.run()
                self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_source_changes_between_initial_snapshots_prevent_all_target_writes(self):
        fake = FakeGitHub()
        asset = fake.asset(fake.source, "app.zip", b"new")
        def changed(api):
            if api.source_lists == 2:
                asset["name"] = "renamed.zip"
        fake.on_source_list = changed
        with self.assertRaisesRegex(mirror.MirrorError, "changed"):
            fake.run()
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_mid_transfer_source_change_keeps_new_target_draft_unpublished(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        def changed(api):
            if api.source_lists == 6:
                api.releases[api.source]["body"] = "Source changed"
        fake.on_source_list = changed
        with self.assertRaisesRegex(mirror.MirrorError, "changed"):
            fake.run()
        self.assertTrue(fake.releases[fake.target]["draft"])
        self.assertFalse(any(event["method"] == "PATCH" and event["route"] == "/releases/2" and event["payload"].get("draft") is False for event in fake.events))

    def test_only_published_stable_releases_and_finished_uploads_are_eligible(self):
        for field, value in (("draft", True), ("prerelease", True), ("state", "starter")):
            with self.subTest(field=field):
                fake = FakeGitHub()
                asset = fake.asset(fake.source, "app.zip", b"new")
                (asset if field == "state" else fake.releases[fake.source])[field] = value
                with self.assertRaises(mirror.MirrorError):
                    fake.run()
                self.assertTrue(all(event["method"] == "GET" for event in fake.events))
        source, target = FakeGitHub().clients()
        for tag in ("v1.2.3.rc1", "baasx-v1.2.3", "updater", "1.2.3-rc.1"):
            with self.assertRaises(mirror.MirrorError):
                mirror.Mirror(source, target, tag)
        self.assertEqual(mirror.Mirror(source, target, "1.2.3.post2").target_tag, "tauri-1.2.3.post2")

    def test_dry_run_is_get_only_without_target_token_or_binary_downloads(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "large.zip", b"pretend GBs")
        result = fake.run(dry_run=True)
        self.assertEqual(result["status"], "planned")
        self.assertFalse(result["sha256-verified"])
        self.assertEqual(fake.downloads, [])
        self.assertNotIn(fake.target, fake.releases)
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))
        self.assertTrue(all(event["authorization"] is None for event in fake.events if event["repo"] == fake.target))

    def test_paginated_source_and_target_include_every_asset_on_rerun(self):
        fake = FakeGitHub()
        for index in range(101):
            fake.asset(fake.source, f"asset-{index:03}.zip", bytes([index]))
            fake.asset(fake.target, f"asset-{index:03}.zip", bytes([index]))
        fake.owned_release()
        result = fake.run()
        self.assertEqual((result["skipped"], len(result["assets"])), (101, 101))
        self.assertEqual(fake.downloads, [])
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_immutable_equal_release_is_noop_but_differences_fail_before_write(self):
        for payload in (b"new", b"old"):
            fake = FakeGitHub()
            fake.asset(fake.source, "app.zip", b"new")
            fake.asset(fake.target, "app.zip", payload)
            fake.owned_release()
            fake.releases[fake.target]["immutable"] = True
            if payload == b"new":
                fake.run()
            else:
                with self.assertRaisesRegex(mirror.MirrorError, "immutable"):
                    fake.run()
            self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_metadata_only_change_is_applied_in_draft_and_publish_patch_has_no_notes(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "app.zip", b"new")
        fake.asset(fake.target, "app.zip", b"new")
        fake.owned_release()
        fake.releases[fake.target]["name"] = "Old title"
        fake.run()
        patches = [event["payload"] for event in fake.events if event["method"] == "PATCH"]
        self.assertEqual(len(patches), 2)
        self.assertTrue(patches[0]["draft"])
        self.assertIn("body", patches[0])
        self.assertEqual(patches[1], {"draft": False, "prerelease": True, "make_latest": "false"})


class InstallerPolicyTests(unittest.TestCase):
    def test_installer_policy_renames_each_platform_and_preserves_exact_bytes(self):
        fake = FakeGitHub()
        prefix = "BAAS.Tauri_1.2.3_"
        mapping = {
            "x64-setup.exe": "win_x64-setup.exe",
            "arm64_fixed_webview2-setup.exe": "win_arm64_fixed_webview2-setup.exe",
            "x86-setup.exe": "win_x86-setup.exe",
            "amd64.deb": "linux_amd64.deb",
            "aarch64.rpm": "linux_aarch64.rpm",
            "x86_64.AppImage": "linux_x86_64.AppImage",
            "aarch64.dmg": "macos_aarch64.dmg",
            "x64.dmg": "macos_x64.dmg",
            "android_arm64-v8a.apk": "android_arm64-v8a.apk",
            "android_armeabi-v7a.apk": "android_armeabi-v7a.apk",
            "android_x86_64.apk": "android_x86_64.apk",
            "linux_arm64.deb": "linux_arm64.deb",
            "win_x64_fixed_webview2-setup.exe": "win_x64_fixed_webview2-setup.exe",
            "macos_universal.dmg": "macos_universal.dmg",
        }
        excluded = ["x64_portable.exe", "arm64_fixed_webview2_portable.zip",
                    "x64-setup.exe.sig", "amd64.deb.sig", "aarch64.app.tar.gz",
                    "aarch64.app.tar.gz.sig", "x64.nsis.zip", "SHA256SUMS",
                    "android_arm64-v8a.apk.sig", "other.exe"]
        data = {}
        for index, (source, target) in enumerate(mapping.items()):
            content = b"\x00exact-installer\xff" + bytes([index])
            fake.asset(fake.source, prefix + source, content)
            data[prefix + target] = content
        for suffix in excluded:
            fake.asset(fake.source, prefix + suffix, b"excluded")
        fake.asset(fake.source, "BAAS.Tauri_1.2.4_x64-setup.exe", b"wrong-version")
        result = fake.run(select_assets=mirror.installer_assets)
        self.assertEqual({a["name"]: fake.content[fake.target, a["id"]] for a in fake.assets[fake.target]}, data)
        self.assertEqual(result["uploaded"], len(mapping))
        self.assertTrue(result["sha256-verified"])
        for entry in result["assets"]:
            self.assertEqual(entry["sha256"], sha(data[entry["name"]]))
            self.assertIn(entry["source-name"], {prefix + name for name in mapping})
        self.assertEqual(len(fake.downloads), len(mapping))
        fake.events.clear()
        fake.downloads.clear()
        repeated = fake.run(select_assets=mirror.installer_assets)
        self.assertEqual(repeated["skipped"], len(mapping))
        self.assertEqual(fake.downloads, [])
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_default_production_policy_is_installers_only_and_dry_run_lists_both_names(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "BAAS.Tauri_1.2.3_x64-setup.exe", b"installer")
        fake.asset(fake.source, "BAAS.Tauri_1.2.3_x64_portable.exe", b"portable")
        source, target = fake.clients(dry_run=True)
        result = mirror.Mirror(source, target, "v1.2.3", dry_run=True, sleep=fake.sleeps.append).run()
        self.assertEqual(len(result["assets"]), 1)
        self.assertEqual(result["assets"][0]["name"], "BAAS.Tauri_1.2.3_win_x64-setup.exe")
        self.assertEqual(result["assets"][0]["source-name"], "BAAS.Tauri_1.2.3_x64-setup.exe")
        self.assertFalse(result["sha256-verified"])
        self.assertEqual(fake.downloads, [])
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_empty_selection_and_renamed_collisions_fail_before_target_writes(self):
        for names in (["x64_portable.exe", "x64-setup.exe.sig"],
                      ["x64-setup.exe", "win_x64-setup.exe"]):
            fake = FakeGitHub()
            for name in names:
                fake.asset(fake.source, "BAAS.Tauri_1.2.3_" + name, b"fixture")
            with self.assertRaises(mirror.MirrorError):
                fake.run(select_assets=mirror.installer_assets)
            self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_excluded_source_asset_changes_still_invalidate_the_source_snapshot(self):
        fake = FakeGitHub()
        fake.asset(fake.source, "BAAS.Tauri_1.2.3_x64-setup.exe", b"installer")
        ignored = fake.asset(fake.source, "BAAS.Tauri_1.2.3_x64_portable.exe", b"portable")
        def change(api):
            if api.source_lists == 2:
                ignored["updated_at"] = "changed"
        fake.on_source_list = change
        with self.assertRaisesRegex(mirror.MirrorError, "changed"):
            fake.run(select_assets=mirror.installer_assets)
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))


class HTTPTests(unittest.TestCase):
    def test_known_release_missing_retries_are_bounded_and_respect_the_deadline(self):
        fake = FakeGitHub()
        _, target = fake.clients()
        for _ in range(target.attempts):
            fake.failure("GET", "/releases/2", 404)
        with self.assertRaises(mirror.APIError) as failure:
            target.release_by_id(2)
        self.assertEqual(failure.exception.status, 404)
        self.assertEqual(len(fake.events), target.attempts)
        self.assertTrue(all(event["method"] == "GET" for event in fake.events))
        self.assertEqual(fake.sleeps, [1, 2, 4, 8])

        fake = FakeGitHub()
        target = mirror.GitHub(fake.target, "target-fixture", opener=fake, sleep=fake.sleeps.append,
                               clock=lambda: 0, deadline=1)
        fake.failure("GET", "/releases/2", 404)
        with self.assertRaisesRegex(mirror.MirrorError, "deadline"):
            target.release_by_id(2)
        self.assertEqual(len(fake.events), 1)
        self.assertEqual(fake.sleeps, [])

    def test_known_release_permission_errors_are_not_retried(self):
        for status in (401, 403):
            with self.subTest(status=status):
                fake = FakeGitHub()
                _, target = fake.clients()
                fake.failure("GET", "/releases/2", status)
                with self.assertRaises(mirror.APIError) as failure:
                    target.release_by_id(2)
                self.assertEqual(failure.exception.status, status)
                self.assertEqual(len(fake.events), 1)
                self.assertEqual(fake.sleeps, [])

    def test_metadata_gets_bypass_cache_and_binary_downloads_keep_existing_headers(self):
        fake = FakeGitHub()
        asset = fake.asset(fake.source, "app.zip", b"new")
        source, _ = fake.clients()
        source.release("v1.2.3")
        with tempfile.TemporaryDirectory() as folder:
            source.download(asset, Path(folder) / "asset")
        self.assertEqual([event["cache-control"] for event in fake.events], ["no-cache", None])

    def test_create_post_transport_failure_has_no_automatic_http_retry(self):
        fake = FakeGitHub()
        _, target = fake.clients()
        fake.failures["POST", "/releases"] = [URLError("connection closed")]
        with self.assertRaises(mirror.NetworkError):
            target.request("POST", "/releases", {"tag_name": "tauri-1.2.3"})
        self.assertEqual(len(fake.events), 1)
        self.assertEqual(fake.sleeps, [])

    def test_permission_errors_are_not_missing_releases_or_retried(self):
        for status in (401, 403, 500):
            fake = FakeGitHub()
            source, target = fake.clients()
            count = target.attempts if status == 500 else 1
            for _ in range(count):
                fake.failure("GET", "/releases/tags/tauri-1.2.3", status)
            with self.assertRaises(mirror.APIError) as failure:
                target.release("tauri-1.2.3")
            self.assertEqual(failure.exception.status, status)
            self.assertEqual(len(fake.events), count)
            self.assertTrue(all(event["method"] == "GET" for event in fake.events))

    def test_rate_limit_and_server_errors_retry_with_bounded_backoff(self):
        fake = FakeGitHub()
        _, target = fake.clients()
        fake.failure("GET", "", 429, headers={"Retry-After": "3"})
        fake.failure("GET", "", 503)
        target.request("GET", "")
        self.assertEqual(fake.sleeps, [3, 2])
        self.assertEqual(len(fake.events), 3)

    def test_retry_after_and_rate_reset_are_not_shortened_to_a_smaller_cap(self):
        for headers, expected in (({"Retry-After": "600"}, 600),
                                  ({"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700"}, 700)):
            fake = FakeGitHub()
            target = mirror.GitHub(fake.target, "target-fixture", opener=fake, sleep=fake.sleeps.append,
                                   clock=lambda: 0, wall=lambda: 1000, deadline=1000)
            fake.failure("GET", "", 403, headers=headers)
            target.request("GET", "")
            self.assertEqual(fake.sleeps, [expected])
        fake = FakeGitHub()
        target = mirror.GitHub(fake.target, "target-fixture", opener=fake, sleep=fake.sleeps.append,
                               clock=lambda: 0, deadline=100)
        fake.failure("GET", "", 429, headers={"Retry-After": "600"})
        with self.assertRaisesRegex(mirror.MirrorError, "deadline"):
            target.request("GET", "")
        self.assertEqual(fake.sleeps, [])

    def test_partial_binary_retry_truncates_prior_bytes_and_hashes_complete_result(self):
        fake = FakeGitHub()
        asset = fake.asset(fake.source, "app.zip", b"complete")
        source, _ = fake.clients()
        fake.failures["GET", f"/releases/assets/{asset['id']}"] = [lambda *_: Response(b"part", {"Content-Length": "8"})]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "asset"
            self.assertEqual(source.download(asset, path), sha(b"complete"))
            self.assertEqual(path.read_bytes(), b"complete")

    def test_cross_origin_download_redirect_strips_auth_and_rejects_insecure_urls(self):
        redirect = mirror.SafeRedirect()
        request = Request("https://api.github.com/repos/example/client/releases/assets/1",
                          headers={"Authorization": "Bearer fixture", "Accept": "application/octet-stream"})
        result = redirect.redirect_request(request, None, 302, "redirect", {}, "https://release-assets.githubusercontent.com/fixture")
        self.assertIsNone(result.get_header("Authorization"))
        same = redirect.redirect_request(request, None, 302, "redirect", {}, "https://api.github.com/fixture")
        self.assertEqual(same.get_header("Authorization"), "Bearer fixture")
        for url in ("http://release-assets.githubusercontent.com/fixture", "https://example.invalid/fixture"):
            with self.assertRaises(mirror.MirrorError):
                redirect.redirect_request(request, None, 302, "redirect", {}, url)

    def test_read_only_clients_reject_writes_before_network(self):
        fake = FakeGitHub()
        source, target = fake.clients(dry_run=True)
        for client in (source, target):
            with self.assertRaises(mirror.MirrorError):
                client.request("POST", "/releases", {"tag_name": "bad"})
        self.assertEqual(fake.events, [])


if __name__ == "__main__":
    unittest.main()
