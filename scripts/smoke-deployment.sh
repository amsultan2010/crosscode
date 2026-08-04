#!/usr/bin/env bash
# Proves a deployment serves the coordination service, not just the static site.
#
# Usage: scripts/smoke-deployment.sh https://www.getcrosscode.dev
#
# The failure this exists to catch: the API function built, deployed, and returned 500 on
# every route because it imported a TypeScript file that Node would not load. The build was
# green and the marketing pages were fine, so nothing else noticed for days.
#
# Two requests, because either one alone is fooled by a plausible deployment:
#   /api/health      must be 200 AND name the service in its body. A path that misses the
#                    function falls through to the static site, which also answers 200.
#   /v1/memberships  must not be a 5xx without credentials. It is the cheapest route that
#                    exercises the real router and auth path rather than a constant, and an
#                    unimportable function answers 500 here even when nothing else is wrong.
set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi
BASE="${BASE%/}"

failures=0

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

status="$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' "$BASE/api/health")"
if [ "$status" = "200" ] && grep -q 'crosscode-service' "$body"; then
  echo "ok   GET $BASE/api/health -> $status $(cat "$body")"
else
  echo "FAIL GET $BASE/api/health -> $status" >&2
  head -c 500 "$body" >&2
  echo >&2
  failures=$((failures + 1))
fi

status="$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' "$BASE/v1/memberships")"
if [ "$status" -ge 500 ]; then
  echo "FAIL GET $BASE/v1/memberships -> $status (the router itself is broken)" >&2
  head -c 500 "$body" >&2
  echo >&2
  failures=$((failures + 1))
else
  echo "ok   GET $BASE/v1/memberships -> $status (refused without credentials, as it should)"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures smoke check(s) failed against $BASE" >&2
  exit 1
fi
echo "Deployment at $BASE serves the coordination service."
