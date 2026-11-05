#!/usr/bin/env bash
#
# Post-deploy: the API's /health answers {"ok":true}.
#
# Retries, because a new Custom Domain can 5xx for a few minutes while its edge
# certificate is issued. A Cloudflare bot challenge is NOT retried: the
# averrow.com zone can challenge CI's IP range before the request reaches the
# Worker (BVOM hits this). That is a zone setting, not a deploy regression, so it
# is reported as a warning - deployed-version.sh, which asks the Cloudflare API
# directly, is what proves the deploy landed in that case.
#
#   usage: health-check.sh <base-url>

set -euo pipefail

BASE="${1:?usage: health-check.sh <base-url>}"
URL="${BASE%/}/health"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

for i in 1 2 3 4 5 6; do
	code="$(curl -sS --max-time 15 -o "$BODY" -w '%{http_code}' "$URL" || echo 000)"

	if grep -qE "challenges\.cloudflare\.com|cType: '(managed|interactive|non-interactive)'" "$BODY"; then
		echo "::warning::/health is UNVERIFIED: $URL answered a Cloudflare bot challenge (HTTP $code) before reaching the Worker."
		echo "Zone setting, not a regression. To let CI through: averrow.com zone > Security > WAF >"
		echo "Custom rules > Skip for (http.host eq \"$(printf '%s' "$BASE" | sed -E 's#^https?://([^/:]+).*#\1#')\")."
		exit 0
	fi

	if [ "$code" = "200" ] && grep -q '"ok":true' "$BODY"; then
		echo "OK: $(cat "$BODY")"
		exit 0
	fi

	echo "attempt $i: HTTP $code $(head -c 200 "$BODY")"
	sleep $((i * 10))
done

echo "::error::$URL did not report ok"
exit 1
