#!/usr/bin/env bash
#
# Fails if any file under migrations/ that existed at BASE was modified, deleted,
# renamed or type-changed. Only brand-new files are allowed.
#
# This is what makes "migrate before deploy" safe: the currently-deployed Worker
# keeps working against the new schema because nothing it reads ever changes
# underneath it.
#
#   usage: check-migrations-immutable.sh <base-ref> [head-ref]

set -euo pipefail

BASE="${1:?usage: check-migrations-immutable.sh <base-ref> [head-ref]}"
HEAD_REF="${2:-HEAD}"
DIR="migrations"

# --diff-filter excludes 'A' (added) on purpose: additions are the only legal change.
# M=modified D=deleted R=renamed C=copied T=typechange
VIOLATIONS="$(git diff --name-status --diff-filter=MDRCT "$BASE" "$HEAD_REF" -- "$DIR" || true)"

if [ -n "$VIOLATIONS" ]; then
	echo "::error::Applied migrations are immutable. Illegal changes under $DIR/:"
	echo "$VIOLATIONS" | sed 's/^/  /'
	echo ""
	echo "Fix: revert these files and add a NEW numbered migration instead."
	exit 1
fi

ADDED="$(git diff --name-only --diff-filter=A "$BASE" "$HEAD_REF" -- "$DIR" | grep '\.sql$' || true)"
if [ -z "$ADDED" ]; then
	echo "OK: no new migrations in this change."
	exit 0
fi

# Highest migration number that already existed at BASE.
MAX_EXISTING="$(git ls-tree -r --name-only "$BASE" -- "$DIR" 2>/dev/null \
	| grep -oE '[0-9]{4}_' | tr -d '_' | sort -n | tail -1 || true)"
MAX_EXISTING="${MAX_EXISTING:-0000}"

FAIL=0
while IFS= read -r f; do
	[ -z "$f" ] && continue
	b="$(basename "$f")"

	if ! printf '%s' "$b" | grep -qE '^[0-9]{4}_[a-z0-9_]+\.sql$'; then
		echo "::error file=$f::bad migration filename; expected NNNN_snake_case.sql"
		FAIL=1
		continue
	fi

	n="${b:0:4}"
	if [ "$((10#$n))" -le "$((10#$MAX_EXISTING))" ]; then
		echo "::error file=$f::migration number $n must be greater than existing max $MAX_EXISTING"
		FAIL=1
	fi

	# Additive-DDL screen. A genuinely necessary destructive change needs a
	# deliberate human override, not a silent pass.
	if grep -qiE '^[[:space:]]*(DROP|ALTER[[:space:]]+TABLE[[:space:]]+[^;]*[[:space:]]+DROP)' "$f"; then
		echo "::error file=$f::destructive statement detected (DROP); requires explicit human override"
		FAIL=1
	fi
done <<< "$ADDED"

DUPES="$(printf '%s\n' "$ADDED" | xargs -n1 basename 2>/dev/null | cut -c1-4 | sort | uniq -d || true)"
if [ -n "$DUPES" ]; then
	echo "::error::duplicate migration numbers in this change: $DUPES"
	FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
	echo "OK: $(printf '%s\n' "$ADDED" | wc -l | tr -d ' ') new migration(s), all append-only."
fi
exit "$FAIL"
