#!/usr/bin/env bash
# Pre-commit validation for exocortex

ERRORS=0
WARNS=0

# Check .env not staged
if git diff --cached --name-only | grep -q '\.env$'; then
  echo "[HOOK] ERROR: .env file staged for commit — remove with: git reset HEAD .env"
  ERRORS=$((ERRORS + 1))
fi

# Warn if scoring.ts changed — remind about benchmarks
if git diff --cached --name-only | grep -q 'packages/core/src/memory/scoring'; then
  echo "[HOOK] WARN: Scoring code changed — run 'pnpm benchmark' to verify retrieval quality"
  WARNS=$((WARNS + 1))
fi

# Check for console.log in production code (not tests)
CONSOLELOGS=$(git diff --cached -U0 -- 'packages/*/src/' 2>/dev/null | grep '^\+.*console\.log' | grep -v '^\+\+\+' | grep -v 'test' | grep -v 'benchmark' || true)
if [ -n "$CONSOLELOGS" ]; then
  echo "[HOOK] WARN: console.log in production code"
  WARNS=$((WARNS + 1))
fi

# Check for personal info in committed code (exocortex is public)
PERSONAL=$(git diff --cached -U0 2>/dev/null | grep -iE '^\+.*(C:\\Users\\[a-z]+\\|[A-Z]:\\Apps\\|\/home\/[a-z]+\/)' | grep -v '^\+\+\+' || true)
if [ -n "$PERSONAL" ]; then
  echo "[HOOK] ERROR: Personal paths/info detected — exocortex is a public repo"
  echo "$PERSONAL"
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -gt 0 ]; then
  echo "[HOOK] Commit blocked: $ERRORS error(s) found"
  exit 1
fi

if [ $WARNS -gt 0 ]; then
  echo "[HOOK] $WARNS warning(s) — review before committing"
fi
