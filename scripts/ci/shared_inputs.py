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
BAASX = {"baasx-native:" + name for name in ("windows", "linux", "macos")}
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
    for root, scope in (("baas-tauri", NATIVE | ANDROID), ("baas-cli-runtime", BAASX)):
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


# Only expressions we can prove are handled. Arbitrary cfg, architectures, and
# unknown target triples retain the package's original consumers.
OS_SCOPES = {
    "windows": {"native:windows", "baasx-native:windows"},
    "linux": {"native:linux", "baasx-native:linux"},
    "macos": {"native:macos", "baasx-native:macos"},
    "android": ANDROID,
}
MEMBERS = {
    "src-tauri/Cargo.toml": ("baas-tauri", NATIVE | ANDROID),
    "crates/baas-cli-runtime/Cargo.toml": ("baas-cli-runtime", BAASX),
    "crates/baas-updater/Cargo.toml": ("baas-updater", NATIVE | ANDROID | BAASX),
    "crates/baas-term/Cargo.toml": ("baas-term", NATIVE | ANDROID | BAASX),
    "crates/baas-notifier/Cargo.toml": ("baas-notifier", NATIVE | ANDROID),
    "crates/baas-i18n/Cargo.toml": ("baas-i18n", NATIVE | ANDROID),
    "crates/baas-shortcut/Cargo.toml": ("baas-shortcut", NATIVE),
}
DEP_TABLES = ("dependencies", "dev-dependencies", "build-dependencies")


def target_scopes(target):
    compact = re.sub(r"\s+", "", target).replace("'", '"')
    for name in OS_SCOPES:
        if compact == f'cfg(target_os="{name}")' or (name == "windows" and compact == "cfg(windows)"):
            return OS_SCOPES[name]
    if compact in ('cfg(not(target_os="android"))', 'cfg(not(any(target_os="android",target_os="ios")))'):
        return OS_SCOPES["windows"] | OS_SCOPES["linux"] | OS_SCOPES["macos"]
    return None


def dependency_name(alias, value):
    if isinstance(value, str):
        return alias
    if isinstance(value, dict):
        return value.get("package", alias)
    raise ValueError("invalid Cargo dependency")


def target_changes(old, new, owners):
    """Return changed target dependency names and scopes, or None if unclear."""
    if {k: v for k, v in old.items() if k != "target"} != {k: v for k, v in new.items() if k != "target"}:
        return None
    old_targets, new_targets = old.get("target", {}), new.get("target", {})
    if not isinstance(old_targets, dict) or not isinstance(new_targets, dict):
        return None
    changed, scopes = set(), set()
    for target in old_targets.keys() | new_targets.keys():
        before, after = old_targets.get(target, {}), new_targets.get(target, {})
        if not isinstance(before, dict) or not isinstance(after, dict):
            return None
        if {k: v for k, v in before.items() if k not in DEP_TABLES} != {k: v for k, v in after.items() if k not in DEP_TABLES}:
            return None
        for field in DEP_TABLES:
            a, b = before.get(field, {}), after.get(field, {})
            if not isinstance(a, dict) or not isinstance(b, dict):
                return None
            for alias in a.keys() | b.keys():
                if a.get(alias) == b.get(alias):
                    continue
                selected = target_scopes(target)
                if selected is None:
                    return None
                if field == "build-dependencies":
                    selected = owners  # Build dependencies execute on the host.
                for entry in (a.get(alias), b.get(alias)):
                    if entry is not None:
                        changed.add(dependency_name(alias, entry))
                scopes.update(owners & selected)
    return changed, scopes


def dependency_targets(manifest, name, owners):
    """Conservatively find every declared platform for one direct dependency."""
    found, scopes = False, set()
    for field in DEP_TABLES:
        table = manifest.get(field, {})
        if not isinstance(table, dict):
            return None
        if any(dependency_name(alias, value) == name for alias, value in table.items()):
            found = True
            scopes.update(owners)
    targets = manifest.get("target", {})
    if not isinstance(targets, dict):
        return None
    for target, sections in targets.items():
        if not isinstance(sections, dict):
            return None
        for field in DEP_TABLES:
            table = sections.get(field, {})
            if not isinstance(table, dict):
                return None
            if any(dependency_name(alias, value) == name for alias, value in table.items()):
                selected = target_scopes(target)
                if selected is None:
                    return None
                found = True
                scopes.update(owners if field == "build-dependencies" else owners & selected)
    return scopes if found else None


def manifests_for_revision(revision):
    root = tomllib.loads(blob(revision, "Cargo.toml"))
    members = root.get("workspace", {}).get("members", [])
    if not isinstance(members, list) or any(not isinstance(m, str) or any(c in m for c in "*?[]") for m in members):
        raise ValueError("unsupported workspace members")
    result = {}
    for member in members:
        path = member.rstrip("/") + "/Cargo.toml"
        if path not in MEMBERS:
            raise ValueError("unknown Cargo workspace member")
        manifest = tomllib.loads(blob(revision, path))
        if manifest.get("package", {}).get("name") != MEMBERS[path][0]:
            raise ValueError("unexpected Cargo package name")
        result[MEMBERS[path][0]] = manifest
    if set(result) != {name for name, _ in MEMBERS.values()}:
        raise ValueError("incomplete workspace manifests")
    return result


def direct_scopes(key, packages, graph, manifests):
    """Narrow only if every incoming edge is a known local manifest edge."""
    name, version, source = key
    scopes, found = set(), False
    for parent, info in packages.items():
        for dep in info.get("dependencies", []):
            parts = dep.split()
            if not parts or parts[0] != name or (len(parts) > 1 and parts[1] != version):
                continue
            if len(parts) > 2 and ' '.join(parts[2:]).strip('()') != source:
                continue
            found = True
            if parent[2] or parent[0] not in manifests:
                return None  # Cargo.lock cannot prove cfg on an external crate edge.
            selected = dependency_targets(manifests[parent[0]], name, graph.get(parent, set()))
            if selected is None:
                return None
            scopes.update(selected)
    return scopes if found else None


def cargo_owners(old, new, old_manifests=None, new_manifests=None):
    old, new = tomllib.loads(old), tomllib.loads(new)
    old_packages, before = cargo_graph(old)
    new_packages, after = cargo_graph(new)
    if {k: v for k, v in old.items() if k != "package"} != {k: v for k, v in new.items() if k != "package"}:
        return NATIVE | ANDROID | BAASX
    scopes = set()
    for key in old_packages.keys() | new_packages.keys():
        previous, current = old_packages.get(key), new_packages.get(key)
        if previous == current:
            continue
        ownership = before.get(key, set()) | after.get(key, set())
        if not ownership:
            return NATIVE | ANDROID | BAASX
        if old_manifests is not None and new_manifests is not None:
            if not key[2] and previous and current and key[0] in old_manifests and key[0] in new_manifests:
                # A local lock node can only be narrowed if its complete change
                # is explained by target-specific manifest dependency changes.
                only_deps = {k: v for k, v in previous.items() if k != "dependencies"} == {k: v for k, v in current.items() if k != "dependencies"}
                diff = target_changes(old_manifests[key[0]], new_manifests[key[0]], ownership)
                changed = {d.split()[0] for d in set(previous.get("dependencies", [])) ^ set(current.get("dependencies", []))}
                if only_deps and diff is not None and changed and changed <= diff[0]:
                    ownership = diff[1]
            elif key[2]:
                selected = set()
                proven = True
                for packages, graph, manifests in ((old_packages, before, old_manifests), (new_packages, after, new_manifests)):
                    if key in packages:
                        value = direct_scopes(key, packages, graph, manifests)
                        if value is None:
                            proven = False
                            break
                        selected.update(value)
                if proven:
                    ownership = selected
        scopes.update(ownership)
    return scopes


# Root commands are shared by different workspaces; the command name identifies its owner.
def root_script_owners(name):
    if name == "baasx" or name.startswith("baasx:"):
        return JS
    if name in ("dev:android", "build:tauri:android"):
        return {"ui:android"}
    if name.startswith("tauri:android:"):
        return ANDROID
    if name in ("test:android-bootstrap", "test:android-smoke"):
        return {"android-tests"}
    if name in ("dev:webui", "build:webui"):
        return {"ui:webui"}
    if name in ("dev:tauri", "build:tauri"):
        return {"ui:tauri"}
    if name in ("dev", "build", "preview", "gen:fonts", "test:transport", "i18n:check", "i18n:sync"):
        return UI
    if name in ("updater", "updater-fixed-webview2", "portable-fixed-webview2"):
        return {"contracts"}
    return UI | JS


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
                    scopes.update(root_script_owners(script))
        else:
            scopes.update(UI | JS)
    return scopes


def cargo_manifest_owners(old, new, old_lock, new_lock):
    old, new = tomllib.loads(old), tomllib.loads(new)
    if {k: v for k, v in old.items() if k != "workspace"} != {k: v for k, v in new.items() if k != "workspace"}:
        return NATIVE | ANDROID | BAASX
    old_ws, new_ws = old.get("workspace", {}), new.get("workspace", {})
    if not isinstance(old_ws, dict) or not isinstance(new_ws, dict):
        raise ValueError("invalid Cargo workspace")
    if {k: v for k, v in old_ws.items() if k != "dependencies"} != {k: v for k, v in new_ws.items() if k != "dependencies"}:
        return NATIVE | ANDROID | BAASX
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
            return NATIVE | ANDROID | BAASX
        scopes.update(owners)
    return scopes


def shared_owners(path, base, head):
    """Return exact known scopes, or conservative ecosystem scopes on ambiguity.

    None means this is not a shared input. Both revisions must be object IDs.
    """
    if path not in SHARED and path not in MEMBERS:
        return None
    fallback = MEMBERS[path][1] if path in MEMBERS else NATIVE | ANDROID | BAASX if path.startswith("Cargo.") else UI | JS
    try:
        old, new = blob(base, path), blob(head, path)
        if path == "bun.lock":
            return bun_owners(old, new)
        if path == "Cargo.lock":
            try:
                old_manifests = manifests_for_revision(base)
                new_manifests = manifests_for_revision(head)
            except (ValueError, TypeError, KeyError, subprocess.CalledProcessError, UnicodeDecodeError):
                # The generic lock graph still identifies consumers when a
                # workspace manifest is missing or an older layout is used.
                return cargo_owners(old, new)
            return cargo_owners(old, new, old_manifests, new_manifests)
        if path == "package.json":
            return manifest_owners(old, new)
        if path in MEMBERS:
            name = MEMBERS[path][0]
            previous, current = tomllib.loads(old), tomllib.loads(new)
            if previous.get("package", {}).get("name") != name or current.get("package", {}).get("name") != name:
                return fallback
            _, before = cargo_graph(tomllib.loads(blob(base, "Cargo.lock")))
            _, after = cargo_graph(tomllib.loads(blob(head, "Cargo.lock")))
            owners = set().union(*(v for k, v in before.items() if k[0] == name and not k[2]),
                                 *(v for k, v in after.items() if k[0] == name and not k[2]))
            if not owners:
                return fallback
            diff = target_changes(previous, current, owners)
            return diff[1] if diff is not None else owners
        return cargo_manifest_owners(old, new, blob(base, "Cargo.lock"), blob(head, "Cargo.lock"))
    except (ValueError, TypeError, KeyError, IndexError, subprocess.CalledProcessError, UnicodeDecodeError):
        return fallback
