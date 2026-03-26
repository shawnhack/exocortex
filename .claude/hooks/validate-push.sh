#!/usr/bin/env bash
# Pre-push validation for exocortex

# Block force push
if echo "$@" | grep -qE '\-\-force|\-f'; then
  echo "[HOOK] ERROR: Force push blocked."
  exit 1
fi

# Warn on push to main
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "[HOOK] WARN: Pushing directly to $BRANCH"
fi
