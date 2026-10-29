#!/usr/bin/env bash

set -euo pipefail

CHANGELOG_FILE="UPDATE.md"

if [[ ! -f "$CHANGELOG_FILE" ]]; then
  echo "❌ File not existed: $CHANGELOG_FILE" >&2
  exit 1
fi

UPDATE_LOGS=$(node --input-type=module <<'NODE'
import { resolveUpdateLog, resolveUpdateLogDefault } from './scripts/update-log.mjs';
import { parseReleaseVersion } from './src/shared/ReleaseVersion.mjs';
const tag = process.env.GITHUB_REF_NAME;
console.log(parseReleaseVersion(tag, { allowLegacy: true })
  ? await resolveUpdateLog(tag)
  : await resolveUpdateLogDefault());
NODE
)

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
  marker="BAAS_CHANGELOG_${RANDOM}_${RANDOM}"
  {
    echo "UPDATE_LOGS<<$marker"
    echo "$UPDATE_LOGS"
    echo "$marker"
  } >> "$GITHUB_ENV"
  echo "✅ Written to GitHub EnvVar UPDATE_LOGS"
fi
