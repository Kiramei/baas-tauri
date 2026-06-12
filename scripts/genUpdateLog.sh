#!/usr/bin/env bash

set -euo pipefail

CHANGELOG_FILE="UPDATE.md"

if [[ ! -f "$CHANGELOG_FILE" ]]; then
  echo "❌ File not existed: $CHANGELOG_FILE" >&2
  exit 1
fi

UPDATE_LOGS=$(awk '
  /^## v/ {
    if (found) exit;
    found=1
  }
  found
' "$CHANGELOG_FILE")

if [[ -z "$UPDATE_LOGS" ]]; then
  echo "⚠️ UPDATE CONTENT NOT FOUND"
  exit 0
fi

echo "✅ The Log is as below："
echo "----------------------------------------"
echo "$UPDATE_LOGS"
echo "----------------------------------------"

# WITH ACTION
if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "UPDATE_LOGS<<EOF"
    echo "$UPDATE_LOGS"
    echo "EOF"
  } >> "$GITHUB_ENV"
  echo "✅ Written to GitHub EnvVar UPDATE_LOGS"
fi