#!/usr/bin/env sh
# Regenerates the iOS and Android icon + splash art from apps/web/assets/
# (icon-only, icon-foreground, icon-background, splash, splash-dark) with
# @capacitor/assets. Run via `pnpm --filter @tagalong/web assets:generate`.
#
# - iOS + Android only: no --pwa, so apps/web/public is never touched.
# - `pnpm dlx` with an exact version keeps sharp out of the lockfile.
# - The tool re-serialises AndroidManifest.xml (formatting only; the icon
#   attributes it sets are already there), so the manifest is restored as-is.
# - Background colours are the theme --bg (#0b0f1a); the app is dark-only, so
#   the dark variants are the same colour.
set -eu
cd "$(dirname "$0")/.."

BG="#0b0f1a"
MANIFEST="android/app/src/main/AndroidManifest.xml"
SAVED="$(mktemp)"
cp "$MANIFEST" "$SAVED"
trap 'cp "$SAVED" "$MANIFEST"; rm -f "$SAVED"' EXIT

pnpm dlx @capacitor/assets@4.0.0 generate --ios --android \
	--assetPath assets \
	--iconBackgroundColor "$BG" --iconBackgroundColorDark "$BG" \
	--splashBackgroundColor "$BG" --splashBackgroundColorDark "$BG"
