# syntax=docker/dockerfile:1.7

ARG PYTHON_VERSION=3.9.0

# ---------- Builder ----------
FROM ghcr.io/astral-sh/uv:trixie-slim AS builder

ARG PYTHON_VERSION

ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_LINK_MODE=copy

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN uv python install ${PYTHON_VERSION}

COPY requirements.txt /tmp/requirements.service.txt

RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /opt/venv --python ${PYTHON_VERSION} \
    && . /opt/venv/bin/activate \
    && uv pip compile /tmp/requirements.service.txt \
        -o /tmp/requirements.service.lock \
    && uv pip sync /tmp/requirements.service.lock \
    && find /opt/venv -type d -name "__pycache__" -prune -exec rm -rf {} + \
    && find /opt/venv -type f \( -name "*.pyc" -o -name "*.pyo" \) -delete


# ---------- Runtime ----------
FROM debian:trixie-slim AS runtime

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
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
              /usr/share/doc/* \
              /usr/share/man/* \
              /var/www/html/* \
    && rm -f /etc/nginx/sites-enabled/default

COPY --from=builder /opt/python /opt/python
COPY --from=builder /opt/venv /opt/venv

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
