"""Attribute shared manifests and lockfile changes to their consumers.

Only committed tree blobs are read: a PR is evaluated against its actual merge
parents, not the runner's mutable working tree. Unknown formats and unresolved
changes deliberately select every affected ecosystem.
"""
import json
import re
import subprocess
import tomllib
from collections import defaultdict, deque

UI = {"ui:webui", "ui:tauri", "ui:android"}
JS = {"baasx-source", "registry", *("baasx-js:" + name for name in ("windows", "linux", "macos"))}
NATIVE = {"native:" + name for name in ("windows", "linux", "macos")}
ANDROID = {"android:arm64", "android-tests"}
CLI = {"baasx-native:" + name for name in ("windows", "linux", "macos")}
SHARED = {"package.json", "bun.lock", "Cargo.lock", "Cargo.toml"}


def blob(revision, path):
    if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", revision):
        raise ValueError("expected immutable Git commit IDs")
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], stderr=subprocess.DEVNULL).decode("utf-8")


def jsonc(text):
    """Parse Bun's JSON with trailing commas, without modifying quoted text."""
    out, quoted, escaped = [], False, False
    index = 0
    while index < len(text):
        ch = text[index]
        if quoted:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
        elif ch == '"':
            quoted = True
            out.append(ch)
        elif ch == ',' and re.match(r"\s*[}\]]", text[index + 1:]):
            pass
        else:
            out.append(ch)
        index += 1
    return json.loads(''.join(out), object_pairs_hook=unique_object)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def workspace_scope(path):
    if path == "":
        return UI
    if path == "baasx" or (path.startswith("baasx/packages/") and all(part not in ("", ".", "..") for part in path.split('/'))):
        return JS
    raise ValueError("unknown Bun workspace")


def package_parts(key):
    pieces, out, i = key.split('/'), [], 0
    while i < len(pieces):
        if not pieces[i]:
            raise ValueError("invalid package key")
        if pieces[i].startswith('@'):
            if i + 1 >= len(pieces):
                raise ValueError("invalid scoped package key")
            out.append(pieces[i] + '/' + pieces[i + 1]); i += 2
        else:
            out.append(pieces[i]); i += 1
    return out


def bun_graph(lock):
    if not isinstance(lock, dict) or lock.get("lockfileVersion") != 1 or not isinstance(lock.get("workspaces"), dict) or not isinstance(lock.get("packages"), dict):
        raise ValueError("unsupported Bun lock")
    workspaces, packages = lock["workspaces"], lock["packages"]
    if "" not in workspaces or "baasx" not in workspaces:
        raise ValueError("missing Bun root workspace")
    names = {}
    for path, workspace in workspaces.items():
        workspace_scope(path)
        if not isinstance(workspace, dict) or not isinstance(workspace.get("name"), str):
            raise ValueError("invalid workspace")
        if workspace["name"] in names:
            raise ValueError("duplicate workspace name")
        names[workspace["name"]] = path
    owners = defaultdict(set)

    def dependencies(value):
        if not isinstance(value, dict):
            raise ValueError("invalid dependency metadata")
        result = {}
        for field in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            deps = value.get(field, {})
            if not isinstance(deps, dict):
                raise ValueError("invalid dependency map")
            result.update(deps)
        return result

    def resolve(parent, workspace_name, dependency):
        # Bun's nested lock keys follow package-name resolution, including scopes.
        parts = package_parts(parent) if parent else []
        candidates = ["/".join(parts[:n] + [dependency]) for n in range(len(parts), 0, -1)]
        candidates.extend([workspace_name + '/' + dependency, dependency])
        return next((item for item in candidates if item in packages), None)

    for path, workspace in workspaces.items():
        scope = workspace_scope(path)
        workspace_name = workspace["name"]
        queue = deque(("", name, False) for name in dependencies(workspace))
        seen = set()
        while queue:
            parent, dep, optional = queue.popleft()
            if not isinstance(dep, str):
                raise ValueError("invalid dependency name")
            key = resolve(parent, workspace_name, dep)
            if key is None:
                if optional:
                    continue
                raise ValueError("unresolved Bun dependency " + dep)
            if key in seen:
                continue
            seen.add(key)
            owners[key].update(scope)
            entry = packages[key]
            if not isinstance(entry, list) or not entry or not isinstance(entry[0], str):
                raise ValueError("unsupported Bun package entry")
            if "@workspace:" in entry[0]:
                workspace_path = entry[0].split("@workspace:", 1)[1]
                if workspace_path not in workspaces:
                    raise ValueError("missing workspace target")
                # A shared workspace can be consumed by either product.
                for child in dependencies(workspaces[workspace_path]):
                    queue.append((key, child, False))
            elif len(entry) >= 3 and isinstance(entry[2], dict):
                meta = entry[2]
                optional_peers = set(meta.get("optionalPeers", []))
                optional_names = set(meta.get("optionalDependencies", {})) | optional_peers
                for child in dependencies(meta):
                    queue.append((key, child, child in optional_names))
            else:
                raise ValueError("unsupported Bun package metadata")
    return owners


def bun_owners(old, new):
    old, new = jsonc(old), jsonc(new)
    before, after = bun_graph(old), bun_graph(new)
    if {k: v for k, v in old.items() if k not in ("packages", "workspaces")} != {k: v for k, v in new.items() if k not in ("packages", "workspaces")}:
        return UI | JS
    scopes = set()
    for path in old["workspaces"].keys() | new["workspaces"].keys():
        if old["workspaces"].get(path) != new["workspaces"].get(path):
            scopes.update(workspace_scope(path))
    old_pkgs, new_pkgs = old["packages"], new["packages"]
    for key in old_pkgs.keys() | new_pkgs.keys():
        if old_pkgs.get(key) != new_pkgs.get(key):
            ownership = before.get(key, set()) | after.get(key, set())
            if not ownership:
                return UI | JS
            scopes.update(ownership)
    return scopes


def cargo_graph(lock):
    if lock.get("version") not in (3, 4) or not isinstance(lock.get("package"), list):
        raise ValueError("unsupported Cargo lock")
    packages = lock["package"]
    by_name = defaultdict(list)
    identities = {}
    for package in packages:
        name, version = package.get("name"), package.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            raise ValueError("invalid Cargo package")
        key = (name, version, package.get("source", ""))
        if key in identities:
            raise ValueError("duplicate Cargo package")
        identities[key] = package
        by_name[name].append(key)
    owners = defaultdict(set)
    for root, scope in (("baas-tauri", NATIVE | ANDROID), ("baas-cli-runtime", CLI)):
        roots = [key for key in by_name[root] if not key[2]]
        if len(roots) != 1:
            raise ValueError("missing or ambiguous Cargo root")
        queue, seen = deque(roots), set()
        while queue:
            key = queue.popleft()
            if key in seen:
                continue
            seen.add(key); owners[key].update(scope)
            dependencies = identities[key].get("dependencies", [])
            if not isinstance(dependencies, list):
                raise ValueError("invalid Cargo dependencies")
            for dependency in dependencies:
                if not isinstance(dependency, str):
                    raise ValueError("invalid Cargo dependency")
                parts = dependency.split()
                candidates = by_name.get(parts[0], [])
                if len(parts) >= 2:
                    candidates = [child for child in candidates if child[1] == parts[1]]
                if len(parts) >= 3:
                    candidates = [child for child in candidates if child[2] == ' '.join(parts[2:]).strip('()')]
                if not candidates:
                    raise ValueError("unresolved Cargo dependency")
                queue.extend(candidates)
    return identities, owners


def cargo_owners(old, new):
    old, new = tomllib.loads(old), tomllib.loads(new)
    old_packages, before = cargo_graph(old)
    new_packages, after = cargo_graph(new)
    if {k: v for k, v in old.items() if k != "package"} != {k: v for k, v in new.items() if k != "package"}:
        return NATIVE | ANDROID | CLI
    scopes = set()
    for key in old_packages.keys() | new_packages.keys():
        if old_packages.get(key) != new_packages.get(key):
            ownership = before.get(key, set()) | after.get(key, set())
            if not ownership:
                return NATIVE | ANDROID | CLI
            scopes.update(ownership)
    return scopes


def manifest_owners(old, new):
    old, new = json.loads(old, object_pairs_hook=unique_object), json.loads(new, object_pairs_hook=unique_object)
    if not isinstance(old, dict) or not isinstance(new, dict):
        raise ValueError("invalid package manifest")
    scopes = set()
    for key in old.keys() | new.keys():
        if old.get(key) == new.get(key):
            continue
        if key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
            scopes.update(UI)
        elif key == "scripts" and isinstance(old.get(key), dict) and isinstance(new.get(key), dict):
            for script in old[key].keys() | new[key].keys():
                if old[key].get(script) != new[key].get(script):
                    scopes.update(JS if script.startswith("baasx") else UI | JS)
        else:
            scopes.update(UI | JS)
    return scopes


def cargo_manifest_owners(old, new, old_lock, new_lock):
    old, new = tomllib.loads(old), tomllib.loads(new)
    if {k: v for k, v in old.items() if k != "workspace"} != {k: v for k, v in new.items() if k != "workspace"}:
        return NATIVE | ANDROID | CLI
    old_ws, new_ws = old.get("workspace", {}), new.get("workspace", {})
    if not isinstance(old_ws, dict) or not isinstance(new_ws, dict):
        raise ValueError("invalid Cargo workspace")
    if {k: v for k, v in old_ws.items() if k != "dependencies"} != {k: v for k, v in new_ws.items() if k != "dependencies"}:
        return NATIVE | ANDROID | CLI
    old_deps, new_deps = old_ws.get("dependencies", {}), new_ws.get("dependencies", {})
    if not isinstance(old_deps, dict) or not isinstance(new_deps, dict):
        raise ValueError("invalid workspace dependencies")
    _, before = cargo_graph(tomllib.loads(old_lock))
    _, after = cargo_graph(tomllib.loads(new_lock))
    scopes = set()
    for key in old_deps.keys() | new_deps.keys():
        if old_deps.get(key) == new_deps.get(key):
            continue
        names = {value.get("package", key) if isinstance(value, dict) else key
                 for value in (old_deps.get(key), new_deps.get(key)) if value is not None}
        owners = set().union(*(value for package, value in (before | after).items() if package[0] in names))
        # The same Cargo identity can be used by different roots in each revision.
        owners.update(*(value for package, value in before.items() if package[0] in names))
        if not owners:
            return NATIVE | ANDROID | CLI
        scopes.update(owners)
    return scopes


def shared_owners(path, base, head):
    """Return exact known scopes, or conservative ecosystem scopes on ambiguity.

    None means this is not a shared input. Both revisions must be object IDs.
    """
    if path not in SHARED:
        return None
    fallback = NATIVE | ANDROID | CLI if path.startswith("Cargo.") else UI | JS
    try:
        old, new = blob(base, path), blob(head, path)
        if path == "bun.lock":
            return bun_owners(old, new)
        if path == "Cargo.lock":
            return cargo_owners(old, new)
        if path == "package.json":
            return manifest_owners(old, new)
        return cargo_manifest_owners(old, new, blob(base, "Cargo.lock"), blob(head, "Cargo.lock"))
    except (ValueError, TypeError, KeyError, IndexError, subprocess.CalledProcessError, UnicodeDecodeError):
        return fallback
