#!/usr/bin/env bash
set -euo pipefail

# Build a clean Gumroad release zip.
# Usage: bash scripts/build-release.sh
#
# Produces: releases/exocortex-v{version}.zip
# Contains: pre-built dist, source, QUICKSTART.md — no node_modules, no tests, no dev files.
# Buyer runs: pnpm install --prod && node packages/server/dist/index.js

VERSION=$(node -p "require('./package.json').version")
RELEASE_DIR="releases/exocortex-v${VERSION}"
ZIP_FILE="releases/exocortex-v${VERSION}.zip"

echo "Building release v${VERSION}..."

# Clean previous
rm -rf "$RELEASE_DIR" "$ZIP_FILE"
mkdir -p "$RELEASE_DIR"

# Build everything
echo "Building packages..."
pnpm build

# Copy root files
cp package.json pnpm-workspace.yaml pnpm-lock.yaml LICENSE README.md ARCHITECTURE.md "$RELEASE_DIR/"

# Copy QUICKSTART for buyers (if exists)
[ -f QUICKSTART.md ] && cp QUICKSTART.md "$RELEASE_DIR/"

# Copy each package (source + dist, no tests/dev files)
for pkg in core mcp server cli dashboard; do
  dest="$RELEASE_DIR/packages/$pkg"
  mkdir -p "$dest"

  # package.json always
  cp "packages/$pkg/package.json" "$dest/"

  # tsconfig if exists
  [ -f "packages/$pkg/tsconfig.json" ] && cp "packages/$pkg/tsconfig.json" "$dest/"

  # Pre-built dist
  if [ -d "packages/$pkg/dist" ]; then
    cp -r "packages/$pkg/dist" "$dest/dist"
  fi

  # Source (needed for pnpm workspace resolution)
  if [ -d "packages/$pkg/src" ]; then
    cp -r "packages/$pkg/src" "$dest/src"
  fi
done

# Dashboard: copy vite config and index.html (needed if buyer wants to rebuild)
cp packages/dashboard/vite.config.ts packages/dashboard/index.html packages/dashboard/tsconfig.json "$RELEASE_DIR/packages/dashboard/" 2>/dev/null || true

# Copy MCP hooks
if [ -d "packages/mcp/src/hooks" ]; then
  mkdir -p "$RELEASE_DIR/packages/mcp/src/hooks"
  cp packages/mcp/src/hooks/*.js "$RELEASE_DIR/packages/mcp/src/hooks/"
fi

# Copy marketplace assets
if [ -d "packages/marketplace" ]; then
  cp -r packages/marketplace "$RELEASE_DIR/packages/marketplace"
fi

# Strip devDependencies from root package.json in release
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$RELEASE_DIR/package.json', 'utf-8'));
  delete pkg.devDependencies;
  delete pkg.private;
  pkg.scripts = {
    serve: 'node packages/server/dist/index.js',
    mcp: 'node packages/mcp/dist/index.js'
  };
  fs.writeFileSync('$RELEASE_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Remove test files from staging
find "$RELEASE_DIR" -name "*.test.ts" -o -name "*.spec.ts" -o -name "vitest*" | xargs rm -f 2>/dev/null || true

# Zip it (use PowerShell on Windows, zip on Unix)
echo "Creating zip..."
if command -v zip &>/dev/null; then
  cd releases
  zip -r "exocortex-v${VERSION}.zip" "exocortex-v${VERSION}"
  cd ..
else
  powershell -Command "Compress-Archive -Path '$RELEASE_DIR' -DestinationPath '$ZIP_FILE' -Force"
fi

# Cleanup staging dir
rm -rf "$RELEASE_DIR"

SIZE=$(du -h "$ZIP_FILE" | cut -f1)
echo ""
echo "Done: $ZIP_FILE ($SIZE)"
echo "Upload this to Gumroad."
