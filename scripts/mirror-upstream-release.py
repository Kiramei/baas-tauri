#!/usr/bin/env python3
"""Mirror app assets without building, moving existing tags, or sharing tokens.

GitHub REST contract: https://docs.github.com/en/rest/releases/assets
Only this tool's marked staging/backup assets may be deleted. Existing canonical
bytes remain available until their replacement has been uploaded and verified.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class MirrorError(RuntimeError):
    pass


class APIError(MirrorError):
    def __init__(self, status, method, repository, headers=None, message=""):
        self.status = status
        self.headers, self.message = headers or {}, message
        super().__init__(f"GitHub {method} for {repository} returned HTTP {status}")


class NetworkError(MirrorError):
    pass


class SafeRedirect(HTTPRedirectHandler):
    """Asset API redirects must not disclose either repository's credential."""

    def redirect_request(self, request, fp, code, message, headers, newurl):
        destination = urlsplit(newurl)
        allowed = {"api.github.com", "github.com", "release-assets.githubusercontent.com",
                   "objects.githubusercontent.com"}
        if destination.scheme != "https" or destination.hostname not in allowed:
            raise MirrorError("Refusing an unexpected GitHub asset redirect")
        redirected = super().redirect_request(request, fp, code, message, headers, newurl)
        if redirected is not None and urlsplit(request.full_url).netloc != destination.netloc:
            redirected.remove_header("Authorization")
        return redirected


def digest(asset):
    value = asset.get("digest")
    return value[7:].lower() if isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-fA-F]{64}", value) else None


def identifier(value):
    if type(value) is not int or value <= 0:
        raise MirrorError("GitHub returned an invalid release or asset ID")
    return value


def repository(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value) or any(part in (".", "..") for part in value.split("/")):
        raise MirrorError("Expected an owner/repository name")
    return value


class GitHub:
    def __init__(self, repo, token, *, read_only=False, opener=None, sleep=time.sleep,
                 clock=time.monotonic, wall=time.time, attempts=5, deadline=None):
        self.repo = repository(repo)
        self.token = token.strip()
        if re.search(r"[\x00-\x20\x7f]", self.token):
            raise MirrorError("GitHub tokens may not contain whitespace or control characters")
        self.read_only = read_only
        self.opener = opener or build_opener(SafeRedirect())
        self.sleep, self.clock, self.wall = sleep, clock, wall
        self.attempts = attempts
        self.deadline = deadline if deadline is not None else clock() + 3300

    def _pause(self, attempt, headers, status, message):
        rate_limited = status == 429 or (status == 403 and (
            headers.get("Retry-After") is not None or headers.get("X-RateLimit-Remaining") == "0"
            or "rate limit" in message.lower()))
        if status and not (rate_limited or 500 <= status < 600):
            return False
        delay = min(2 ** attempt, 30)
        retry_after = headers.get("Retry-After")
        if retry_after:
            try:
                delay = max(delay, float(retry_after))
            except ValueError:
                try:
                    delay = max(delay, parsedate_to_datetime(retry_after).timestamp() - self.wall())
                except (TypeError, ValueError, OverflowError):
                    pass
        elif rate_limited and headers.get("X-RateLimit-Remaining") == "0":
            try:
                delay = max(delay, float(headers.get("X-RateLimit-Reset", "0")) - self.wall())
            except ValueError:
                pass
        delay = max(0, delay)
        if self.clock() + delay >= self.deadline:
            raise MirrorError("Mirror deadline reached while waiting for GitHub")
        print(f"GitHub retry {attempt + 1}/{self.attempts - 1} after {delay:g}s (HTTP {status or 'network'})")
        self.sleep(delay)
        return True

    def request(self, method, route, payload=None, *, upload=None, name=None, label=None, destination=None):
        if self.read_only and method != "GET":
            raise MirrorError("A read-only GitHub client cannot mutate a repository")
        host = "uploads.github.com" if upload is not None else "api.github.com"
        url = f"https://{host}/repos/{self.repo}{route}"
        if name is not None:
            url += "?" + urlencode({"name": name, "label": label or ""})
        headers = {"Accept": "application/octet-stream" if destination else "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "baas-tauri-release-mirror"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if upload is not None:
            headers["Content-Type"] = "application/octet-stream"
            headers["Content-Length"] = str(upload.stat().st_size)
        for attempt in range(self.attempts):
            if self.clock() >= self.deadline:
                raise MirrorError("Mirror deadline reached")
            try:
                with ExitStack() as stack:
                    data = stack.enter_context(upload.open("rb")) if upload else (
                        json.dumps(payload).encode() if payload is not None else None)
                    request = Request(url, data=data, headers=headers, method=method)
                    response = stack.enter_context(self.opener.open(request, timeout=60))
                    if destination is not None:
                        sha, size = hashlib.sha256(), 0
                        output = stack.enter_context(destination.open("wb"))
                        while True:
                            if self.clock() >= self.deadline:
                                raise MirrorError("Mirror deadline reached during asset transfer")
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            output.write(chunk)
                            sha.update(chunk)
                            size += len(chunk)
                        content_length = response.headers.get("Content-Length")
                        if content_length is not None and size != int(content_length):
                            raise http.client.IncompleteRead(b"", int(content_length) - size)
                        return sha.hexdigest(), size
                    body = response.read()
                    try:
                        return json.loads(body) if body else None
                    except (UnicodeError, ValueError):
                        raise MirrorError("GitHub returned malformed JSON") from None
            except HTTPError as error:
                try:
                    message = json.loads(error.read(1024 * 1024)).get("message", "")
                except (UnicodeError, ValueError, AttributeError):
                    message = ""
                finally:
                    error.close()
                # Release creation is not safely repeatable: draft lookup and
                # reconciliation belong to the caller before another POST.
                if (method == "POST" and route == "/releases") or attempt + 1 == self.attempts or not self._pause(attempt, error.headers, error.code, str(message)):
                    raise APIError(error.code, method, self.repo, error.headers, str(message)) from None
            except (URLError, TimeoutError, OSError, http.client.HTTPException):
                if (method == "POST" and route == "/releases") or attempt + 1 == self.attempts:
                    raise NetworkError(f"GitHub {method} for {self.repo} failed after bounded network retries") from None
                self._pause(attempt, {}, 0, "")

    def release(self, tag):
        try:
            return self.request("GET", "/releases/tags/" + quote(tag, safe=""))
        except APIError as error:
            if error.status != 404:
                raise
            return None

    def assets(self, release_id):
        result, page = [], 1
        while True:
            items = self.request("GET", f"/releases/{identifier(release_id)}/assets?per_page=100&page={page}")
            if not isinstance(items, list):
                raise MirrorError("GitHub returned an invalid asset list")
            result.extend(items)
            if len(items) < 100:
                return result
            page += 1

    def find_release(self, tag):
        """Drafts are not reliably returned by the published-tag endpoint."""
        result = self.release(tag)
        page, matches = 1, {identifier(result.get("id")): result} if result else {}
        while True:
            items = self.request("GET", f"/releases?per_page=100&page={page}")
            if not isinstance(items, list):
                raise MirrorError("GitHub returned an invalid release list")
            for item in items:
                if item.get("tag_name") == tag:
                    matches[identifier(item.get("id"))] = item
            if len(matches) > 1:
                raise MirrorError("Multiple target releases use the mirror tag; refusing ambiguous ownership")
            if len(items) < 100:
                return next(iter(matches.values())) if matches else None
            page += 1

    def download(self, asset, path):
        result, size = self.request("GET", f"/releases/assets/{identifier(asset['id'])}", destination=path)
        if size != asset["size"] or (digest(asset) and result != digest(asset)):
            raise MirrorError("Downloaded asset failed its size or SHA256 verification")
        return result


def asset_map(assets, *, source=False):
    result = {}
    for asset in assets:
        identifier(asset.get("id"))
        name = asset.get("name")
        if not isinstance(name, str) or not name or name in result:
            raise MirrorError("GitHub returned empty or duplicate asset names")
        if type(asset.get("size")) is not int or asset["size"] < 0:
            raise MirrorError("GitHub returned an invalid asset size")
        if source and asset.get("state") != "uploaded":
            raise MirrorError("A source asset has not finished uploading")
        result[name] = asset
    return result


@dataclass
class Snapshot:
    release: dict
    assets: dict
    signature: str


class Mirror:
    def __init__(self, source, target, tag, *, dry_run=False, settle_seconds=5, sleep=time.sleep):
        if source.repo.lower() == target.repo.lower():
            raise MirrorError("Source and target repositories must be different")
        match = re.fullmatch(r"v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.post(?:0|[1-9]\d*))?)", tag)
        if not match:
            raise MirrorError("Only canonical stable app release tags may be mirrored")
        self.source, self.target, self.tag = source, target, tag
        self.version, self.target_tag = match[1], "tauri-" + match[1]
        self.dry_run, self.settle_seconds, self.sleep = dry_run, settle_seconds, sleep
        self.marker = f"<!-- baas-tauri-mirror:v1 source={source.repo} tag={tag} -->"
        self.namespace = hashlib.sha256(self.marker.encode()).hexdigest()[:20]
        self.verified = {}

    def snapshot(self):
        release = self.source.release(self.tag)
        if not release or release.get("draft") is not False or release.get("prerelease") is not False:
            raise MirrorError("Source must be an existing published stable release")
        if release.get("tag_name") != self.tag:
            raise MirrorError("Source release tag does not match the requested tag")
        assets = asset_map(self.source.assets(identifier(release.get("id"))), source=True)
        if not assets:
            raise MirrorError("Source release has no uploaded assets")
        state = {"release": {key: release.get(key) for key in
                 ("id", "tag_name", "draft", "prerelease", "name", "body", "published_at", "updated_at")},
                 "assets": [{key: asset.get(key) for key in
                 ("id", "name", "size", "state", "digest", "label", "content_type", "updated_at")}
                 for _, asset in sorted(assets.items())]}
        return Snapshot(release, assets, json.dumps(state, sort_keys=True))

    def unchanged(self):
        if self.snapshot().signature != self.baseline.signature:
            raise MirrorError("Source release or asset set changed during synchronization")

    def owned(self, release):
        if release.get("tag_name") != self.target_tag or not str(release.get("body") or "").startswith(self.marker + "\n"):
            raise MirrorError("Existing target release lacks the exact mirror ownership marker")

    def working_label(self, asset, sha):
        return f"baas-tauri-mirror:{self.namespace}:{asset['id']}:{sha}"

    def working(self, asset):
        match = re.fullmatch(rf"baas-tauri-mirror:{self.namespace}:(\d+):([0-9a-f]{{64}})", asset.get("label") or "")
        if not match or int(match[1]) not in {item["id"] for item in self.baseline.assets.values()}:
            return False
        prefix = f"__baas_tauri_mirror_{match[1]}_"
        name = asset["name"]
        return name == prefix + match[2] + ".stage" or bool(re.fullmatch(re.escape(prefix) + r"\d+\.backup", name))

    def inventory(self, release):
        items = asset_map(self.target.assets(identifier(release["id"])))
        unknown = [name for name, asset in items.items() if name not in self.baseline.assets and not self.working(asset)]
        if unknown:
            raise MirrorError("Unexpected target assets; nothing will be deleted: " + json.dumps(sorted(unknown)))
        return items

    def target_hash(self, asset, directory):
        if asset.get("state") != "uploaded":
            return None
        if digest(asset):
            return digest(asset)
        key = (asset["id"], asset["size"])
        if key not in self.verified:
            self.verified[key] = self.target.download(asset, directory / f"target-{asset['id']}")
        return self.verified[key]

    def rename(self, asset, name, label):
        return self.target.request("PATCH", f"/releases/assets/{asset['id']}", {"name": name, "label": label or ""})

    def stage(self, release, asset, sha, path, directory):
        name = f"__baas_tauri_mirror_{asset['id']}_{sha}.stage"
        if name in self.baseline.assets:
            raise MirrorError("A source filename collides with the internal staging namespace")
        for attempt in range(self.target.attempts):
            existing = self.inventory(release).get(name)
            if existing:
                if not self.working(existing) or existing.get("label") != self.working_label(asset, sha):
                    raise MirrorError("Staging filename is owned by another operation")
                if existing["size"] == asset["size"] and self.target_hash(existing, directory) == sha:
                    return existing
                self.target.request("DELETE", f"/releases/assets/{existing['id']}")
            if not path.exists():
                self.source.download(asset, path)
                self.unchanged()
            try:
                uploaded = self.target.request("POST", f"/releases/{release['id']}/assets", upload=path,
                                               name=name, label=self.working_label(asset, sha))
            except (NetworkError, APIError) as error:
                if isinstance(error, APIError) and error.status != 422 and error.status < 500:
                    raise
                # An upload may have succeeded before its response was lost.
                if attempt + 1 == self.target.attempts:
                    recovered = self.inventory(release).get(name)
                    if recovered and self.working(recovered) and recovered["size"] == asset["size"] and self.target_hash(recovered, directory) == sha:
                        return recovered
                    raise
                continue
            if uploaded.get("name") != name or uploaded.get("label") != self.working_label(asset, sha):
                raise MirrorError("GitHub changed the staging filename or ownership label")
            if uploaded["size"] != asset["size"] or self.target_hash(uploaded, directory) != sha:
                raise MirrorError("Uploaded staging asset failed SHA256 verification; old asset was retained")
            return uploaded
        raise MirrorError("Asset staging retries exhausted")

    def promote(self, release, old, staged, asset, sha, directory):
        backup = None
        try:
            if old:
                backup_name = f"__baas_tauri_mirror_{asset['id']}_{old['id']}.backup"
                if backup_name in self.inventory(release):
                    raise MirrorError("Backup filename already exists; old asset was retained")
                backup = {**old, "name": backup_name}
                self.rename(old, backup_name, self.working_label(asset, sha))
            promoted = self.rename(staged, asset["name"], asset.get("label"))
            if promoted.get("name") != asset["name"] or promoted["size"] != asset["size"] or self.target_hash(promoted, directory) != sha:
                raise MirrorError("Promoted asset failed verification")
            return promoted
        except (MirrorError, KeyError):
            # Restore the old public name when promotion did not complete. A
            # completed rename with a lost response is recognized by its ID/hash.
            current = self.inventory(release)
            canonical = current.get(asset["name"])
            if canonical and canonical["id"] == staged["id"] and canonical["size"] == asset["size"] and self.target_hash(canonical, directory) == sha:
                return canonical
            if not canonical and backup and backup["name"] in current:
                try:
                    self.rename(backup, asset["name"], old.get("label"))
                except MirrorError:
                    print("Old bytes remain in the marked backup; rerun to resume promotion")
            raise

    def run(self):
        self.baseline = self.snapshot()
        self.sleep(self.settle_seconds)
        self.unchanged()
        target_repo = self.target.request("GET", "")
        release = self.target.find_release(self.target_tag)
        if release:
            self.owned(release)
            current = self.inventory(release)
        else:
            current = {}
            try:
                existing_tag = self.target.request("GET", "/git/ref/tags/" + quote(self.target_tag, safe=""))
            except APIError as error:
                if error.status != 404:
                    raise
                existing_tag = None
            if existing_tag:
                raise MirrorError("Existing target tag has no owned mirror release")
        result = {"status": "planned" if self.dry_run else "synced", "target-tag": self.target_tag,
                  "release-url": f"https://github.com/{self.target.repo}/releases/tag/{self.target_tag}"}
        if self.dry_run:
            result.update({"sha256-verified": False, "assets": [{"name": name, "size": asset["size"],
                "action": "skip-by-server-digest" if name in current and asset["size"] == current[name]["size"] and digest(asset) and digest(asset) == digest(current[name]) else ("verify-or-replace" if name in current else "upload"),
                "source-sha256": digest(asset)} for name, asset in sorted(self.baseline.assets.items())]})
            return result

        source_url = f"https://github.com/{self.source.repo}/releases/tag/{quote(self.tag, safe='')}"
        desired = {"name": self.baseline.release.get("name") or self.tag,
                   "body": self.marker + f"\nMirror of [{self.source.repo} {self.tag}]({source_url}).\n\n" + (self.baseline.release.get("body") or "")}
        mutating = False

        def begin_changes():
            nonlocal release, mutating
            if mutating:
                return
            fresh = self.target.find_release(self.target_tag)
            if not fresh or fresh.get("id") != release.get("id"):
                raise MirrorError("Target release changed during synchronization")
            self.owned(fresh)
            release = fresh
            if release.get("immutable"):
                raise MirrorError("An immutable target mirror differs; no assets were changed")
            self.unchanged()
            # Editing a draft does not trigger GitHub's release:edited Actions.
            # https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release
            if release.get("draft") is not True or any(release.get(key) != value for key, value in desired.items()) or release.get("prerelease") is not True:
                release = self.target.request("PATCH", f"/releases/{release['id']}", {
                    **desired, "draft": True, "prerelease": True, "make_latest": "false"})
            mutating = True

        self.unchanged()
        if not release:
            branch = target_repo.get("default_branch")
            if not isinstance(branch, str) or not branch:
                raise MirrorError("Target repository has no default branch")
            head = self.target.request("GET", "/branches/" + quote(branch, safe=""))
            sha = head.get("commit", {}).get("sha", "")
            if not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
                raise MirrorError("Target default branch HEAD is invalid")
            for attempt in range(self.target.attempts):
                try:
                    release = self.target.request("POST", "/releases", {"tag_name": self.target_tag,
                        "target_commitish": sha, **desired,
                        "draft": True, "prerelease": True, "make_latest": "false"})
                    identifier(release.get("id"))
                    self.owned(release)
                    if release.get("draft") is not True or release.get("prerelease") is not True:
                        raise MirrorError("GitHub did not create the requested draft prerelease")
                    break
                except (NetworkError, APIError) as error:
                    release = self.target.find_release(self.target_tag)
                    if release:
                        identifier(release.get("id"))
                        self.owned(release)
                        break
                    if attempt + 1 == self.target.attempts:
                        raise
                    if isinstance(error, APIError):
                        if not self.target._pause(attempt, error.headers, error.status, error.message):
                            raise
                    else:
                        self.target._pause(attempt, {}, 0, "")
            begin_changes()

        counts, hashes, manifest = {"skipped": 0, "uploaded": 0, "replaced": 0}, {}, []
        with tempfile.TemporaryDirectory(prefix="baas-tauri-mirror-") as temporary:
            directory = Path(temporary)
            for name, asset in sorted(self.baseline.assets.items()):
                self.unchanged()
                local = directory / f"source-{asset['id']}"
                sha = digest(asset) or self.source.download(asset, local)
                hashes[name] = sha
                old = self.inventory(release).get(name)
                if old and old["size"] == asset["size"] and self.target_hash(old, directory) == sha:
                    counts["skipped"] += 1
                else:
                    begin_changes()
                    staged = self.stage(release, asset, sha, local, directory)
                    self.unchanged()
                    self.promote(release, old, staged, asset, sha, directory)
                    counts["replaced" if old else "uploaded"] += 1
                manifest.append({"name": name, "size": asset["size"], "sha256": sha,
                                 "source-verification": "github-server-digest" if digest(asset) else "downloaded-bytes"})
                local.unlink(missing_ok=True)

            self.unchanged()
            final = self.inventory(release)
            for name, asset in self.baseline.assets.items():
                target = final.get(name)
                if not target or target["size"] != asset["size"] or self.target_hash(target, directory) != hashes[name]:
                    raise MirrorError("Final target asset set failed size/SHA256 verification")
            self.unchanged()
            for name, asset in final.items():
                if name not in self.baseline.assets and self.working(asset):
                    begin_changes()
                    self.target.request("DELETE", f"/releases/assets/{asset['id']}")
            fresh = self.target.find_release(self.target_tag)
            if not fresh or fresh.get("id") != release["id"]:
                raise MirrorError("Target release changed before publication")
            self.owned(fresh)
            release = fresh
            if mutating and (release.get("draft") is not True or release.get("prerelease") is not True or any(release.get(key) != value for key, value in desired.items())):
                raise MirrorError("Target draft metadata changed before publication; leaving it unpublished")
            if release.get("draft") is not False or release.get("prerelease") is not True or any(release.get(key) != value for key, value in desired.items()):
                begin_changes()
            if mutating:
                self.unchanged()
                self.target.request("PATCH", f"/releases/{release['id']}", {
                    "draft": False, "prerelease": True, "make_latest": "false"})
            published = self.target.find_release(self.target_tag)
            if not published or published.get("draft") is not False or published.get("prerelease") is not True:
                raise MirrorError("Target was not published as a prerelease")
            self.owned(published)
            if any(published.get(key) != value for key, value in desired.items()):
                raise MirrorError("Published target title or notes did not match the source release")
            final = self.inventory(published)
            if set(final) != set(self.baseline.assets):
                raise MirrorError("Final target contains unexpected or missing assets")
            for name, asset in final.items():
                if asset["size"] != self.baseline.assets[name]["size"] or self.target_hash(asset, directory) != hashes[name]:
                    raise MirrorError("Published target assets failed final SHA256 verification")
            self.unchanged()
        return {**result, **counts, "sha256-verified": True, "assets": manifest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-repository", required=True)
    parser.add_argument("--target-repository", default="pur1fying/blue_archive_auto_script")
    parser.add_argument("--tag-name", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.dry_run and not os.environ.get("TARGET_GITHUB_TOKEN"):
        raise MirrorError("A separate target repository token is required for synchronization")
    deadline = time.monotonic() + 3300
    source = GitHub(args.source_repository, os.environ.get("SOURCE_GITHUB_TOKEN", ""), read_only=True, deadline=deadline)
    target = GitHub(args.target_repository, os.environ.get("TARGET_GITHUB_TOKEN", ""), read_only=args.dry_run, deadline=deadline)
    result = Mirror(source, target, args.tag_name, dry_run=args.dry_run).run()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            for key in ("target-tag", "release-url", "status"):
                output.write(f"{key}={result[key]}\n")


if __name__ == "__main__":
    try:
        main()
    except (MirrorError, KeyError, TypeError, ValueError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
