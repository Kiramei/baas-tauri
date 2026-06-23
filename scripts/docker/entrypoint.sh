#!/bin/sh
set -eu

APP_DIR="/app"
REPO_URL="${1:-}"
BRANCH="${BRANCH:-master}"

export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt

if [ -z "$REPO_URL" ]; then
    echo "[ERROR] Missing repository URL."
    echo "Usage: docker run <image> <repo-url>"
    exit 1
fi

echo "[INFO] Checking nginx config..."
nginx -t

echo "[INFO] Starting nginx..."
nginx

mkdir -p "$APP_DIR"
cd "$APP_DIR"

setup_no_update() {
    if [ ! -f "setup.toml" ]; then
        return 1
    fi
    value="$(awk '
        /^\[.*\]$/ { section=$0 }
        (section == "[General]" || section == "[general]") {
            line=$0
            gsub(/[[:space:]]/, "", line)
            split(line, parts, "=")
            if (parts[1] == "no_update") {
                print tolower(parts[2])
                exit
            }
        }
    ' setup.toml)"
    [ "$value" = "true" ]
}

if setup_no_update; then
    echo "[INFO] no_update is enabled. Skipping repository update."
elif [ ! -d ".git" ]; then
    echo "[INFO] No git repository found. Cloning repository..."
    git clone \
        --branch "$BRANCH" \
        --depth 1 \
        "$REPO_URL" \
        .
else
    echo "[INFO] Git repository found. Pulling latest changes..."
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
    git pull --ff-only origin "$BRANCH"
fi

echo "[INFO] Starting Python service..."
exec /opt/venv/bin/python main.service.py --host 0.0.0.0 --port 8190
