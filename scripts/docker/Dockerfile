# syntax=docker/dockerfile:1.7

ARG PYTHON_VERSION

# The upstream OCR repository ships a Linux x64 prebuild. Build the ARM64
# Linux executable from the same project, using Debian's matching libraries.
FROM debian:trixie-slim AS ocr-builder

ARG TARGETARCH
COPY ocr-arm64.cmake /tmp/ocr-arm64.cmake
RUN mkdir -p /opt/baas-ocr \
    && if [ "$TARGETARCH" = arm64 ]; then \
        apt-get update && apt-get install -y --no-install-recommends \
            ca-certificates cmake g++ git ninja-build pkg-config python3 \
            libcpp-httplib-dev libonnxruntime-dev libopencv-dev libspdlog-dev nlohmann-json3-dev \
        && git init /tmp/BAAS_Cpp \
        && git -C /tmp/BAAS_Cpp fetch --depth=1 https://github.com/pur1fying/BAAS_Cpp.git 753901eb4678693992ef33e58abaa4d854bbdb63 \
        && git -C /tmp/BAAS_Cpp checkout --detach FETCH_HEAD \
        && cmake -S /tmp/BAAS_Cpp -B /tmp/ocr-build -G Ninja \
            -DCMAKE_BUILD_TYPE=Release -DBUILD_BAAS_OCR=ON \
            -DCMAKE_PROJECT_BAAS_INCLUDE=/tmp/ocr-arm64.cmake \
        && cmake --build /tmp/ocr-build --parallel 2 --target BAAS_ocr_server BAAS_ipc \
        && cp -a /tmp/ocr-build/bin/. /opt/baas-ocr/ \
        && cp /tmp/BAAS_Cpp/LICENSE /opt/baas-ocr/LICENSE; \
    fi

# ---------- Builder ----------
FROM ghcr.io/astral-sh/uv:trixie-slim AS builder

ARG PYTHON_VERSION
ARG TARGETARCH

ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_LINK_MODE=copy

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.service.txt

RUN --mount=type=cache,id=baas-webui-uv-${TARGETARCH},target=/root/.cache/uv \
    case "$TARGETARCH" in \
        amd64) default_python=3.9.0 ;; \
        arm64) default_python=3.9.25 ;; \
        *) echo "Unsupported WebUI image architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && python_version="${PYTHON_VERSION:-$default_python}" \
    && uv python install "$python_version" \
    && uv venv /opt/venv --python "$python_version" \
    && . /opt/venv/bin/activate \
    && uv pip compile /tmp/requirements.service.txt \
        -o /tmp/requirements.service.lock \
    && uv pip sync /tmp/requirements.service.lock \
    && find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete


# ---------- Runtime ----------
FROM debian:trixie-slim AS runtime

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    nginx-light \
    libnginx-mod-http-brotli-filter \
    libnginx-mod-http-brotli-static \
    git \
    libgl1 \
    libglib2.0-0t64 \
    libstdc++6 \
    libgcc-s1 \
    zlib1g \
    && if [ "$TARGETARCH" = arm64 ]; then \
        apt-get install -y --no-install-recommends \
            adb libcpp-httplib0.18 libonnxruntime1.21 libopencv-imgcodecs410 libspdlog1.15; \
    fi \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
              /usr/share/doc/* \
              /usr/share/man/* \
              /var/www/html/* \
    && rm -f /etc/nginx/sites-enabled/default

COPY --from=builder /opt/python /opt/python
COPY --from=builder /opt/venv /opt/venv
COPY --from=ocr-builder /opt/baas-ocr /opt/baas-ocr

# Nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/ /usr/share/nginx/html/

# ---- Runtime scripts ----
COPY entrypoint.sh /entrypoint.sh
COPY container.py /usr/local/bin/baas-container.py

RUN git config --system --add safe.directory /app \
    && chmod +x /entrypoint.sh \
    && nginx -t \
    && test -f /usr/share/nginx/html/index.html

VOLUME ["/app"]

EXPOSE 8191

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["/opt/venv/bin/python", "/usr/local/bin/baas-container.py", "--healthcheck"]

STOPSIGNAL SIGTERM

ENTRYPOINT ["/entrypoint.sh"]
