#!/usr/bin/env bash
# scripts/lib/common.sh — shared helpers for WasmNUX scripts (ROADMAP §8).
# Source it:  . "$(dirname "$0")/../lib/common.sh"   (adjust depth as needed)
set -euo pipefail

# Repo root = git toplevel (or two levels up from scripts/lib)
if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
export REPO_ROOT

# --- logging ---------------------------------------------------------------
log()  { printf '\033[1;34m[wnx]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[wnx:warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[wnx:fail]\033[0m %s\n' "$*" >&2; exit 1; }

# --- environment checks ----------------------------------------------------
require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
  done
}

require_node() {
  require_cmd node npm
  node -e 'const [maj]=process.versions.node.split("."); if (+maj < 20) { console.error("Node >= 20 required"); process.exit(1); }'
}

# --- workspace -------------------------------------------------------------
ensure_workspaces_installed() {
  require_node
  if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
    log "node_modules missing — npm install"
    (cd "${REPO_ROOT}" && npm install --no-audit --no-fund)
  fi
}

# --- results ---------------------------------------------------------------
# Benchmark results are tracked per commit (ROADMAP §5).
results_dir_for_commit() {
  local sha="${GITHUB_SHA:-$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || echo local)}"
  echo "${REPO_ROOT}/benchmarks/results/${sha:0:12}"
}

save_results() {
  # save_results <json-file> [label]
  local src="$1" label="${2:-manual}"
  local dir
  dir="$(results_dir_for_commit)"
  mkdir -p "$dir"
  cp "$src" "${dir}/${label}.json"
  log "results saved → ${dir}/${label}.json"
}

# --- temp files ------------------------------------------------------------
TMPDIRS=()
mktempdir() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/wnx.XXXXXX")"
  TMPDIRS+=("$d")
  echo "$d"
}
cleanup_tmp() {
  local d
  for d in "${TMPDIRS[@]:-}"; do [[ -n "$d" && -d "$d" ]] && rm -rf "$d"; done
  TMPDIRS=()
}
trap cleanup_tmp EXIT
