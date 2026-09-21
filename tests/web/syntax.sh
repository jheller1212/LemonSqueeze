#!/bin/bash
# Syntax-check every script the page, the functions and the tests load.
# `node --check file.js` does NOT check a .js file that uses import/export: it re-parses it as a module and
# reports success without checking. Module files are therefore fed through stdin with an explicit module type.
fail=0
for f in web/*.js web/lib/*.js netlify/functions/*.mjs tests/web/*.mjs tests/web/ui/*.mjs tests/web/unit/*.mjs; do
  if grep -qE '^(import|export) ' "$f"; then
    node --input-type=module --check < "$f" > /dev/null 2>&1 || { echo "syntax error (module): $f"; node --input-type=module --check < "$f" 2>&1 | head -4; fail=1; }
  else
    node --check "$f" || { echo "syntax error: $f"; fail=1; }
  fi
done
[ "$fail" = 0 ] && echo "syntax ok" || exit 1
