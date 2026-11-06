#!/usr/bin/env bash
#
# Spec §8: "Provider keys and ANTHROPIC_API_KEY are Worker secrets. CI greps the
# built bundle for them."
#
# CI never holds the real secret values, so this looks for two things instead:
#   1. In the WEB bundle (shipped to every browser): any secret's NAME. The web
#      app has no business referring to a secret at all.
#   2. In EVERY bundle: anything shaped like a real key - Anthropic, Google API,
#      Google OAuth client secret, or a private key block. A key pasted into
#      source to "just test something" is the failure this exists for.
#
#   usage: check-bundle-secrets.sh <web-dist> [<other-dist>...]

set -euo pipefail

WEB="${1:?usage: check-bundle-secrets.sh <web-dist> [<other-dist>...]}"
shift || true

NAMES='SESSION_SECRET|GOOGLE_CLIENT_SECRET|ANTHROPIC_API_KEY|TICKETMASTER_API_KEY|GOOGLE_MAPS_API_KEY|CLOUDFLARE_API_TOKEN'
SHAPES='sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|GOCSPX-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

FAIL=0

if [ ! -d "$WEB" ]; then
	echo "::error::$WEB does not exist - build the web app first"
	exit 1
fi

if hits="$(grep -rEno "$NAMES" "$WEB" 2>/dev/null)"; then
	echo "::error::the web bundle refers to a server secret by name:"
	printf '%s\n' "$hits" | sed 's/^/  /'
	FAIL=1
fi

for dir in "$WEB" "$@"; do
	[ -d "$dir" ] || { echo "::error::$dir does not exist"; FAIL=1; continue; }
	if hits="$(grep -rEnoI "$SHAPES" "$dir" 2>/dev/null)"; then
		echo "::error::something shaped like a real key is in $dir:"
		# Print where, never the value itself.
		printf '%s\n' "$hits" | cut -d: -f1,2 | sed 's/^/  /'
		FAIL=1
	fi
done

if [ "$FAIL" -eq 0 ]; then
	echo "OK: no secret names in $WEB, no key-shaped strings in $WEB $*"
fi
exit "$FAIL"
