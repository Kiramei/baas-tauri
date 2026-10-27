# WebUI with Docker

The image serves the browser UI and proxies its authenticated backend connections through one port, `8191`. The Python service listens only on the container's loopback interface at `127.0.0.1:8190`; do not publish port `8190`. A normal browser deployment does not need Tauri or a desktop session.

## Start and persist an installation

From the repository root:

```sh
docker compose -f scripts/docker/docker-compose.yml up -d
docker compose -f scripts/docker/docker-compose.yml ps
```

These commands use the published image by default. To exercise changes in this source branch, build the local image as described below and select it with `BAAS_WEBUI_IMAGE`.

Open `http://127.0.0.1:8191`. On the first visit, initialize the service password. Subsequent visits use the service's remembered-session cookie or ask for the password again. No password is embedded in the image.

The Compose file stores the service checkout, profiles, authentication state and logs in `scripts/docker/app/` on the host. Keep this directory across image replacement, and back it up before updating. The UI assets and Python packages belong to the image; backend source updates alone do not update those assets or dependencies.

The default backend source is `https://github.com/Kiramei/baas-dev.git`, branch `master`. Set `BRANCH` when starting Compose to select another service-enabled branch. To use a different repository, change the service's `command` URL in the Compose file.

First installation clones into a temporary directory, verifies that `main.service.py` exists, then fills missing files in `/app`. Existing files, including a preseeded `setup.toml` and profile files under `config/`, are retained. Existing Git checkouts update by fast-forward only; local edits or divergent history are never reset or stashed automatically.

To keep the installed backend unchanged, edit `/app/setup.toml`:

```toml
[general] # [General] is also accepted
no_update = true # keep the installed backend version
```

`no_update` must be a TOML boolean. The backend can generate a legacy `[General]` table beside an existing `[general]` table during startup. The launcher reads `general.no_update` first, falls back to `General.no_update` when the modern flag is absent, and defaults to updating when neither flag exists. Invalid TOML or invalid types in the selected table/flag stop startup before Git changes. Enabling the flag on an empty volume does not install a backend; an existing `main.service.py` is required. An installed checkout with this flag can start without supplying a repository URL.

The image's health check requests nginx's local `/health` route, so both nginx and the backend must respond. Startup includes cloning and backend initialization; allow time for the container to become healthy. If either process exits, the container stops its sibling and exits unsuccessfully so the restart policy can recover it. `docker compose stop` forwards shutdown to both services, waits up to ten seconds, and then stops any remaining process group.

## OCR installation

Before starting the service, the launcher checks `core/ocr/baas_ocr_client/bin/` in the persistent `/app` volume for the executable, IPC/ONNX/OpenCV libraries, model catalog, model files, dictionaries and model test images. A missing or incomplete installation is cloned with Git CLI from `https://github.com/pur1fying/BAAS_Cpp_prebuild.git`, branch `linux-x64`, validated, and installed as a complete runtime. This default prebuild supports Linux x86-64. Other compatible repositories or branches can be selected with the container environment variables `BAAS_OCR_REPO_URL` and `BAAS_OCR_BRANCH`.

A complete existing OCR installation is retained without a network check. Repairing an incomplete runtime preserves `bin/config/` and `bin/output/`; missing settings start from the packaged default. `no_update = true` also prevents OCR downloads: if the runtime is missing, startup reports which files are required instead of silently starting without OCR. Preinstall a complete runtime or temporarily disable that flag to allow installation.

The launcher passes `BAAS_SERVICE_OCR_UPDATE_CHECK=0` to the backend to avoid its separate Gitee update path. OCR itself remains enabled: the backend starts the server from its `bin` directory, initializes the real models and runs its normal OCR self-tests. OCR's default loopback port `1145` does not need publishing. Configuration changes made by the backend remain in the persistent volume. When manually seeding OCR, copy the actual library/resource contents rather than absolute symlinks to files on another host.

## Ports, LAN access and ADB

The default Compose configuration uses bridge networking and publishes only `127.0.0.1:8191`. A different host port can be selected without changing the browser's backend address:

```sh
BAAS_WEBUI_PORT=18191 docker compose -f scripts/docker/docker-compose.yml up -d
```

For access from another machine on the LAN, set `BAAS_WEBUI_BIND=0.0.0.0` and open the host's LAN address on the chosen port. Restrict exposure using the host firewall or an authenticated HTTPS reverse proxy.

Bridge mode has its own loopback interface. In a profile's ADB connection settings, use an emulator/device TCP address reachable from the container, for example `host.docker.internal:5555` for a host TCP endpoint or `192.168.1.42:5555` for a LAN device. The Compose file adds `host.docker.internal` through Docker's host-gateway mapping. An endpoint bound only to the host's `127.0.0.1` is not reachable through that gateway; an ADB server on port `5037` is also distinct from an emulator/device TCP endpoint on port `5555`.

Linux deployments that need host-loopback ADB access can opt into host networking with Docker Compose 2.24.4 or newer:

```sh
docker compose -f scripts/docker/docker-compose.yml \
  -f scripts/docker/docker-compose.host.yml up -d
```

The override removes published-port mappings because host mode uses the actual host ports `8191` and loopback-only `8190`. `BAAS_WEBUI_PORT` and `BAAS_WEBUI_BIND` do not apply in host mode. Ensure those ports are available before choosing it. Host mode does not require changing or stopping an existing ADB server or other containers; use the existing device endpoint in the profile.

## HTTPS and browser capabilities

The supplied nginx listener is HTTP. An outer HTTPS reverse proxy should forward the original `Host`, WebSocket `Upgrade`/`Connection` headers and `X-Forwarded-Proto: https`, with a sufficiently long WebSocket read timeout. The inner nginx preserves a forwarded scheme only when it is exactly `http` or `https`, allowing the backend to set the remembered-session cookie's `Secure` flag correctly. Configure the outer proxy to overwrite this header from clients. No separate backend port or cross-origin URL is required.

Authentication has crypto fallbacks for LAN HTTP. Browser clipboard access can still be unavailable outside a secure context; copying requires browser support or a UI fallback. The WebUI's system-log viewer contains logs from the current browser. Native/service administration routes under `/system/` and `/android/` are intentionally not exposed by nginx and return JSON 404 responses.

Hashed Vite files under `/assets/` are immutable-cacheable. The HTML entry point and locale JSON revalidate so a reload can load a new UI and matching translations; other stable public assets have a short cache lifetime. Missing assets return 404, while page routes use the SPA entry point.

## Build and validate locally

For browser development, `bun run dev:webui` serves the UI through Vite and proxies backend traffic to `http://127.0.0.1:8190` by default. To develop against an isolated Docker instance published on another port:

```sh
VITE_BAAS_PROXY_TARGET=http://127.0.0.1:28191 bun run dev:webui
```

The browser still connects to the Vite origin. Production builds use the page's own origin, preserving custom ports and HTTPS; an explicit `VITE_BAAS_WS_BASE` remains available to override the connection URL when a separate backend is intentional.

The Docker build context is `scripts/docker`, and it expects a prepared WebUI `dist/` directory. The release workflow performs these steps; for a local build:

```sh
bun install --frozen-lockfile
bun run build:webui
mkdir -p scripts/docker/dist
cp -a dist/. scripts/docker/dist/
docker build -t baas-webui:local scripts/docker
BAAS_WEBUI_IMAGE=baas-webui:local docker compose -f scripts/docker/docker-compose.yml up -d
```

Backend dependencies come from `scripts/docker/requirements.txt` and are installed in the image. Changing them requires rebuilding the image. The first boot needs access to the selected Git repository unless a complete backend has already been seeded with `no_update = true`.

Startup regression tests use temporary local Git repositories and mocked service processes; they do not start nginx, Python BAAS services, or containers:

```sh
python3 scripts/tests/test_docker_entrypoint.py -v
```

For a full container test, use a fresh named volume and an unused local port. Use a service-enabled backend URL or the default below:

```sh
docker volume create baas-webui-check-data
docker run -d --name baas-webui-check \
  -p 127.0.0.1:18191:8191 \
  -v baas-webui-check-data:/app \
  baas-webui:local https://github.com/Kiramei/baas-dev.git
docker inspect --format '{{.State.Health.Status}}' baas-webui-check
curl --fail http://127.0.0.1:18191/health
```

Verify first-password initialization, reload/session restore, profile creation and configuration save, page reload, and persistence after restarting that test container. Confirm `/system/logs` and `/android/reset-auth` return JSON 404, missing assets return 404, and the browser connects only to the frontend origin. A separate LAN-HTTP or test-hostname browser run covers clipboard behavior outside localhost's secure-context exception. Stop and remove only the named test container; retain its test volume when checking persistence or remove it explicitly after finishing.

The existing Docker release workflow's stable/latest publication policy is unchanged. A local build or manual workflow run on a development branch does not imply that the registry's `latest` tag was updated.

## Local validation (2026-10-27)

The `fix/webui-mode` image was built and exercised on this Linux machine with isolated data directories and published frontend ports. These checks used the real service and browser, including OCR initialization:

- Empty-directory installation, first-password setup and real OCR model self-tests.
- Same-origin HTTP on a custom port, LAN-style insecure HTTP crypto/clipboard fallback, and HTTPS/WSS behind a TLS proxy with a Secure, HttpOnly session cookie.
- Profile creation, ADB/capture-setting saves, browser reload, ZIP export/import, light/dark appearance and a 390-pixel viewport.
- Container replacement preserving remembered login, three test profiles, device settings and theme; an existing installation with `no_update = true` also started without a repository argument.
- ADB access through `host.docker.internal:5555` and a real 1280×720 game video in the WebUI.
- Backend termination stopping nginx and exiting the container unsuccessfully, allowing a restart policy to recover it.

The frontend test suite (288 tests), container launcher suite (24 tests), TypeScript checks and all three frontend build modes passed. Native desktop and Android functionality remain in their own build modes. The test did not start an automation task or publish an image to the registry.
