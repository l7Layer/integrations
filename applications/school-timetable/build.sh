#!/usr/bin/env bash
set -euo pipefail

# Install the repository dependencies and generate the shared OpenIntegration assets.
npm ci --prefix ../..

# The Worker serves this integration folder as its static asset root.
# Copy the shared runtime, stylesheet and fonts into the paths used by render.html.
mkdir -p assets/fonts
cp ../../public/paperless.css assets/paperless.css
cp ../../public/paperless.iife.js assets/paperless.iife.js
cp ../../public/fonts/* assets/fonts/
