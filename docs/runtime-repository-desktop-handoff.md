# Desktop runtime repository handoff

BAAS Tauri orchestrates runtime repository publication; it does not implement
repository policy. The desktop command `runtime_repository_apply_signed_plan`
accepts one opaque publisher-signed UTF-8 envelope, at most 128 KiB. The WebUI
has no command fields for a repository URL, ref, commit, trust key, filesystem
path, or generation. The TypeScript helper preserves this boundary and sends
only `{ request: { envelope } }`.

The command resolves the BAAS project root only through Tauri's trusted
`ensure_default_config` path. It then executes the exact packaged
`BAAS_runtime_repository_update` resource from Tauri's owned resource
directory. PATH lookup, environment overrides, user-selected executables,
renamed programs, and symlink/reparse escapes are rejected. The envelope is
written directly to standard input; it is never placed in argv or a temporary
file. Execution time, stdout, and stderr are bounded, and stdout must be the
publisher's strict machine JSON.

The packaged C++ publisher contains the fixed Ed25519 product trust key and
uses the statically linked libgit2 boundary to verify the signed plan, fetch the
exact scripts/resources commits, validate their trees, and atomically publish
the generation. Scripts and resources remain external, dynamically updated
repository data; neither Tauri nor the C++ service compiles them into an
executable. Tauri re-opens and validates the published store after the child
exits and never treats stdout alone as a generation handoff.

If Python is selected, publication does not switch, stop, or restart it. If C++
is selected, Tauri stops and restarts only after the newly published generation
has been independently re-read, and accepts the restart only when `/health`
reports that exact generation. Tauri does not attempt to launch the old
generation after a restart failure: `current.json` already selects the new
generation, and a correct rollback must atomically update both the native
pointer and trusted-plan policy state. Until the native publisher exposes that
trusted rollback entry, the failure report marks rollback unavailable and the
backend remains stopped. Publisher rejection, crash, timeout, invalid output,
or failed store validation does not restart either backend. Concurrent apply
requests are serialized across publication and handoff.

The post-publication read is strictly read-only. It acquires a shared handle on
the native `.writer.lock`, validates the existing pointer, immutable snapshot,
both object trees, and tree manifests, and releases the lock. It never creates
store directories and never replays or removes a native publication journal;
a pending journal fails the handoff and remains for the native publisher's next
recovery pass.

## Production integration gate

The C++ publisher and its signer/feed are not yet published as a stable release
pin. CI and release builds therefore require both repository variables below:

- `BAAS_CPP_DEV_RUNTIME_REPOSITORY_REF`: the reviewed and pushed 40-character
  `baas-cpp-dev` commit containing `BAAS_service` and
  `BAAS_runtime_repository_update`.
- `BAAS_RUNTIME_REPOSITORY_TRUSTED_PUBLIC_KEY_HEX`: the production signer's
  fixed 64-character lowercase Ed25519 public key.

The build action validates both values before checkout/configuration and never
falls back to a branch or a previous C++ SHA. Production enablement remains
gated until the corresponding private signing pipeline and authenticated signed
plan feed publish envelopes for that exact product key. Tauri does not create,
rewrite, or accept unsigned repository plans.
