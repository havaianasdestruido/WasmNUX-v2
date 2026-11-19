#!/usr/bin/env bash
# scripts/utils/check-phase0.sh — one-shot Phase 0 exit-criteria gate.
# Verifies: tests green, typecheck clean, ADRs 0001–0012 present, RESULTS.md
# exists with a JIT decision, benchmark results artifact writable.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/../lib/common.sh"

log "Phase 0 exit-criteria check"
ensure_workspaces_installed
cd "${REPO_ROOT}"

log "1/5 typecheck"
npm run typecheck --silent

log "2/5 tests"
npx vitest run --reporter=basic

log "3/5 ADRs 0001–0012"
missing=0
for n in 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012; do
  ls docs/adr/${n}-*.md >/dev/null 2>&1 || { warn "missing ADR ${n}"; missing=1; }
done
[[ "$missing" -eq 0 ]] || die "ADR set incomplete"
log "all 12 ADRs present"

log "4/5 Phase 0 report with JIT decision"
[[ -f docs/phase0/RESULTS.md ]] || npm run phase0:report --silent
grep -q "JIT decision\|JIT go/no-go" docs/phase0/RESULTS.md \
  || die "RESULTS.md missing JIT go/no-go section"
log "RESULTS.md OK"

log "5/5 benchmark results directory"
dir="$(results_dir_for_commit)"
mkdir -p "$dir"
log "results dir ready: ${dir}"

log "Phase 0 gate: PASS"
