#!/usr/bin/env bash
# Companion to checkout-evolve-branch.sh — returns HEAD to the default branch
# once an evolve job has finished committing its proposal.
#
# Why this exists:
#   checkout-evolve-branch.sh moves HEAD onto sentinel/<job> and nothing ever
#   moved it back. Because these jobs run unattended against a shared working
#   copy, HEAD stayed parked on the evolve branch indefinitely — so the *next*
#   commit made in that repo, by anyone or anything, silently landed on the
#   evolve branch instead of the default one.
#
#   That happened four separate times in a single session on 2026-08-01, each
#   needing manual cherry-pick or fast-forward to recover. The commits were
#   never lost, but they were invisible to `git push origin main` and easy to
#   miss.
#
# What it does NOT do:
#   - does not merge, push, or delete the evolve branch. The proposal stays put
#     for human review, which is the whole point of the branch workflow.
#
# Usage: bash scripts/finish-evolve-branch.sh
set -euo pipefail

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

CURRENT=$(git rev-parse --abbrev-ref HEAD)

if [ "$CURRENT" = "$DEFAULT_BRANCH" ]; then
  echo "Already on $DEFAULT_BRANCH — nothing to do."
  exit 0
fi

# Refuse to move with uncommitted work rather than dragging it across branches
# or discarding it. An evolve job reaching here with a dirty tree means it
# failed to commit, and that should be loud.
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty on '$CURRENT'. Commit or stash before returning to $DEFAULT_BRANCH." >&2
  git status --short >&2
  exit 1
fi

git checkout "$DEFAULT_BRANCH" --quiet
echo "Returned HEAD to $DEFAULT_BRANCH (proposal left on '$CURRENT' for review)."
