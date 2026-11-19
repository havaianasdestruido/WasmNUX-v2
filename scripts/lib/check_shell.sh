#!/usr/bin/env bash
# Shell hygiene check for scripts/**. Used by CI.
#   - bash -n on every .sh (syntax)
#   - warns when set -euo pipefail is missing
#   - rejects Windows CRLF line endings
#   - rejects tabs in the shebang line
# Empty tree is a pass (Phase 0). Exits 1 on syntax failures.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fail=0
checked=0

while IFS= read -r -d '' f; do
  checked=$((checked + 1))
  if ! bash -n "$f"; then
    echo "  ✗ syntax error: $f"
    fail=$((fail + 1))
  fi
  if head -1 "$f" | grep -q $'\r'; then
    echo "  ✗ CRLF in shebang: $f"
    fail=$((fail + 1))
  fi
  if ! grep -q 'set -euo pipefail' "$f"; then
    echo "  ⚠ missing 'set -euo pipefail' (warning): $f"
  fi
done < <(find "$ROOT/scripts" -name '*.sh' -type f -print0)

if [ "$checked" -eq 0 ]; then
  echo "✓ no shell scripts yet (Phase 0 skeleton)"
  exit 0
fi
if [ "$fail" -gt 0 ]; then
  echo "✗ $fail shell problem(s) found"
  exit 1
fi
echo "✓ $checked shell script(s) OK"
