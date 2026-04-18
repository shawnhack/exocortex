#!/usr/bin/env bash
# Sentinel-evolve work-branch checkout, preserving prior unmerged proposals.
#
# Replaces the previous "git checkout -B <branch> master" pattern, which:
#   1. Hardcoded `master` (broke when default branch was renamed to main)
#   2. Force-recreated the branch every run, destroying any prior auto-proposal
#      that hadn't been reviewed + merged in the intervening week
#
# New behavior:
#   - Resolves the real default branch (origin/HEAD), so it works regardless of
#     master/main naming
#   - If the work branch exists with prior unmerged commits, rebases them onto
#     current default — proposals survive across runs even if the user is slow
#     to review
#   - If rebase produces conflicts (e.g. this run wants to touch the same lines
#     as a prior unmerged proposal), aborts and recreates the branch fresh —
#     same fail-safe as the old force-reset, but only when actually needed
#
# Usage: bash scripts/checkout-evolve-branch.sh <branch-name>
set -euo pipefail

BRANCH="${1:?branch name required, e.g. sentinel/code-evolve}"

# Resolve the default branch from the remote HEAD ref (handles main/master/etc).
# Fallback to local probing if no remote HEAD is set yet.
DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
if [ -z "$DEFAULT_BRANCH" ]; then
  if git rev-parse --verify main >/dev/null 2>&1; then
    DEFAULT_BRANCH=main
  elif git rev-parse --verify master >/dev/null 2>&1; then
    DEFAULT_BRANCH=master
  else
    echo "ERROR: no main or master branch found, and origin/HEAD is unset" >&2
    exit 1
  fi
fi

git checkout "$DEFAULT_BRANCH" --quiet

if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  # Branch exists from a prior run — try to preserve its commits via rebase
  git checkout "$BRANCH" --quiet
  if git rebase "$DEFAULT_BRANCH" --quiet 2>/dev/null; then
    echo "rebased $BRANCH onto $DEFAULT_BRANCH (preserved prior unmerged work)"
  else
    # Rebase conflict — bail out and recreate fresh, matching old fail-safe.
    git rebase --abort 2>/dev/null || true
    git checkout "$DEFAULT_BRANCH" --quiet
    git branch -D "$BRANCH"
    git checkout -B "$BRANCH" "$DEFAULT_BRANCH" --quiet
    echo "rebase conflict — recreated $BRANCH fresh from $DEFAULT_BRANCH (prior work discarded)"
  fi
else
  # First run for this branch
  git checkout -B "$BRANCH" "$DEFAULT_BRANCH" --quiet
  echo "created $BRANCH from $DEFAULT_BRANCH"
fi
