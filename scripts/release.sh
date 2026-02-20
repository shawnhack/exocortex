#!/usr/bin/env bash
set -euo pipefail

# Usage: pnpm release [patch|minor|major]
# Defaults to patch if no argument given.
#
# Steps:
# 1. Ensure working tree is clean
# 2. Run tests
# 3. Bump version in root package.json
# 4. Commit, tag, push
# 5. Create GitHub release with auto-generated changelog

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: pnpm release [patch|minor|major]"
  exit 1
fi

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Run tests
echo "Running tests..."
pnpm test
echo ""

# Get current version
OLD_VERSION=$(node -p "require('./package.json').version")

# Bump version
IFS='.' read -r MAJOR MINOR PATCH <<< "$OLD_VERSION"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

echo "Bumping $OLD_VERSION → $NEW_VERSION ($BUMP)"

# Update root package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Generate changelog from commits since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  CHANGELOG=$(git log "$LAST_TAG"..HEAD --pretty=format:"- %s" --no-merges | grep -v "^- chore" | grep -v "^- docs" || true)
else
  CHANGELOG=$(git log --pretty=format:"- %s" --no-merges | grep -v "^- chore" | grep -v "^- docs" || true)
fi

if [[ -z "$CHANGELOG" ]]; then
  CHANGELOG="- Maintenance and improvements"
fi

# Commit and tag
git add package.json
git commit -m "release: v$NEW_VERSION"
git tag "v$NEW_VERSION"

# Push
git push && git push origin "v$NEW_VERSION"

# Create GitHub release
gh release create "v$NEW_VERSION" \
  --title "v$NEW_VERSION" \
  --notes "$(cat <<EOF
## Changes

$CHANGELOG

**Full changelog**: https://github.com/shawnhack/exocortex/compare/$LAST_TAG...v$NEW_VERSION
EOF
)"

echo ""
echo "Released v$NEW_VERSION"
echo "https://github.com/shawnhack/exocortex/releases/tag/v$NEW_VERSION"
