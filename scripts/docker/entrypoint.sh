#!/bin/sh
set -eu

export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
exec /opt/venv/bin/python /usr/local/bin/baas-container.py "$@"
