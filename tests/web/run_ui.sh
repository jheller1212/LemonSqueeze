#!/bin/bash
# Run every UI check (headless Chrome, local dev server unless a URL is given). Exit 1 if any check fails.
#   bash tests/web/run_ui.sh [https://deployed.site/]
cd "$(dirname "$0")/../.." || exit 1
fail=0
for t in tests/web/ui/*.mjs; do
  out=$(node "$t" "$@" 2>&1 | grep -v 'Warning\|Reparsing\|eliminate this warning\|trace-warnings')
  if echo "$out" | grep -q 'all checks passed'; then echo "PASS  $(basename "$t")  ($(echo "$out" | grep -c '^  ok') checks)"
  else echo "FAIL  $(basename "$t")"; echo "$out" | grep -E 'FAIL|Error|timed out' | head -8; fail=1; fi
done
exit $fail
