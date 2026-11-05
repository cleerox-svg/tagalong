#!/usr/bin/env bash
#
# Assert that the version of a Worker now serving production was built from a
# given commit.
#
# Why this is not just `curl https://.../health`: it has to work when the public
# hostname does not. The zone in front of both Workers issues a Cloudflare bot
# challenge to CI's IP range, so every request from a runner is answered by the
# challenge page before it reaches the Worker (see smoke-check.sh). That is a
# zone setting, not a deploy regression - but it left the deploy with no way at
# all to confirm the new code went live, which is the one thing a post-deploy
# check exists to establish.
#
# The Cloudflare API is a different origin with its own authentication, so it is
# not behind that zone and cannot be challenged. `wrangler deploy` stamps each
# Worker version with --tag, which the API returns as an annotation - so the
# active version can be asked which commit it came from, directly, with no
# traffic through the zone at all.
#
# The tag is read rather than the GIT_SHA binding because an assets-only Worker
# has no bindings to read: run #39 deployed bvom-web with --var GIT_SHA and the
# API answered "carries no GIT_SHA binding", while bvom-api matched. The
# annotation is version metadata and does not depend on there being a script to
# bind anything to. The binding is still accepted as a second source, since the
# API Worker does carry one and `/health` serves it.
#
#   usage: deployed-version.sh <worker-name> <expected-sha>
#
# Exit codes are deliberately asymmetric:
#
#   1  the live version names a DIFFERENT commit. The deploy reported success
#      and did not take effect; that is a real failure and the only one here.
#   0  everything else, including every way of failing to find out (no
#      credentials, an API error, an unrecognised response shape, no GIT_SHA on
#      the version). Unverified is not the same as broken, and a check that goes
#      red when it cannot see is a check people start ignoring.

set -euo pipefail

WORKER="${1:?usage: deployed-version.sh <worker-name> <expected-sha>}"
EXPECTED="${2:?usage: deployed-version.sh <worker-name> <expected-sha>}"

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
TOKEN="${CLOUDFLARE_API_TOKEN:-}"

unverified() {
	echo "::warning::$WORKER: could not confirm which commit is live - $1"
	exit 0
}

[ -n "$ACCOUNT" ] || unverified "CLOUDFLARE_ACCOUNT_ID is not set"
[ -n "$TOKEN" ] || unverified "CLOUDFLARE_API_TOKEN is not set"

# Overridable so the script can be exercised against a local stub; production
# never sets it.
API_BASE="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
API="$API_BASE/accounts/$ACCOUNT/workers/scripts/$WORKER"

cf_get() {
	curl -sS --max-time 30 -H "Authorization: Bearer $TOKEN" "$1" 2>/dev/null || true
}

deployments="$(cf_get "$API/deployments")"
[ -n "$deployments" ] || unverified "the deployments API did not answer"

# `.result` is an object holding `deployments` on the current API and has been an
# array before now; accept either rather than break on a shape change.
version_id="$(
	printf '%s' "$deployments" |
		jq -r '
			(.result // {})
			| (if type == "array" then . else (.deployments // []) end)
			| first
			| .versions // []
			| sort_by(.percentage // 0)
			| last
			| .version_id // empty
		' 2>/dev/null || true
)"

if [ -z "$version_id" ]; then
	errors="$(printf '%s' "$deployments" | jq -r '[.errors[]?.message] | join("; ")' 2>/dev/null || true)"
	unverified "no active version in the API response${errors:+ ($errors)}"
fi

version="$(cf_get "$API/versions/$version_id")"
[ -n "$version" ] || unverified "the versions API did not answer"

# Both sources, in one list. Recursive descent rather than fixed paths into
# `.result.annotations` and `.result.resources.bindings`: both keys are
# distinctive enough to find anywhere, so this survives the metadata moving.
stamps="$(
	printf '%s' "$version" |
		jq -r '
			[
				(.. | objects | ."workers/tag"? // empty),
				(.. | objects | select(.name? == "GIT_SHA") | .text? // empty)
			]
			| map(select(type == "string" and . != ""))
			| unique
			| join(" ")
		' 2>/dev/null || true
)"

[ -n "$stamps" ] || unverified "version $version_id carries no commit stamp (no workers/tag annotation, no GIT_SHA binding)"

for stamp in $stamps; do
	if [ "$stamp" = "$EXPECTED" ]; then
		echo "OK: $WORKER is serving $EXPECTED (version $version_id)."
		exit 0
	fi
done

echo "::error::$WORKER: the live version is stamped $stamps, not $EXPECTED."
echo "The deploy step reported success, so this means the upload did not become"
echo "the active version - check the Workers dashboard for this script before"
echo "trusting anything the app says about itself."
exit 1
