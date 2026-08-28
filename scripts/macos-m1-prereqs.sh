#!/usr/bin/env bash
# macOS Apple Silicon (M1/M2/M3) prerequisite installer for building
# zotero-remarkable-sync.xpi
#
# Checks each build dependency and installs anything missing, one package at
# a time. No extra runtime daemons: this plugin talks to the reMarkable cloud
# from inside Zotero and does not need Ollama, GROBID, or Docker to compile.
#
# Usage (from the repo root, or any cwd — the script locates the repo):
#   bash scripts/macos-m1-prereqs.sh
#   bash scripts/macos-m1-prereqs.sh --build     # also run `npm run build`
#
# Requires network access and (for Homebrew/Xcode CLT) an interactive session.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_NODE_MAJOR=18
DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    -h | --help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

step=0
installed=0
skipped=0

log() { printf '%s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
need() { printf '  need  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

begin() {
  step=$((step + 1))
  printf '\n[%d] %s\n' "$step" "$*"
}

ensure_arm64_macos() {
  begin "Check macOS Apple Silicon"
  [[ "$(uname -s)" == "Darwin" ]] || die "This script is for macOS only (found $(uname -s))."
  local arch
  arch="$(uname -m)"
  if [[ "$arch" != "arm64" ]]; then
    die "Expected Apple Silicon (arm64 / M1+). This machine reports '${arch}'. Run under native arm64 Terminal, not Rosetta."
  fi
  ok "Darwin $(sw_vers -productVersion 2>/dev/null || echo '?') arm64"
}

# Prefer Homebrew's arm64 prefix over any Rosetta /usr/local tools.
prefer_homebrew_path() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
}

xcode_clt_ok() {
  xcode-select -p >/dev/null 2>&1 && [[ -x /usr/bin/clang ]]
}

ensure_xcode_clt() {
  begin "Xcode Command Line Tools (clang, make, git bootstrap)"
  if xcode_clt_ok; then
    ok "already present ($(xcode-select -p))"
    skipped=$((skipped + 1))
    return
  fi
  need "installing — macOS will open a GUI installer; wait until it finishes"
  xcode-select --install 2>/dev/null || true
  local waited=0
  while ! xcode_clt_ok; do
    if (( waited >= 1800 )); then
      die "Command Line Tools did not appear after 30 minutes. Finish the installer, then re-run this script."
    fi
    sleep 5
    waited=$((waited + 5))
    if (( waited % 30 == 0 )); then
      log "  … still waiting for Command Line Tools (${waited}s)"
    fi
  done
  ok "installed"
  installed=$((installed + 1))
}

brew_bin() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    echo /opt/homebrew/bin/brew
    return
  fi
  command -v brew 2>/dev/null || true
}

ensure_homebrew() {
  begin "Homebrew (Apple Silicon prefix /opt/homebrew)"
  prefer_homebrew_path
  local b
  b="$(brew_bin)"
  if [[ -n "$b" && -x "$b" ]]; then
    if [[ "$b" != /opt/homebrew/bin/brew ]]; then
      die "Found Homebrew at $b, not /opt/homebrew. On M1 use the arm64 installer (https://brew.sh), not a Rosetta /usr/local copy."
    fi
    ok "already present ($("$b" --version | head -1))"
    skipped=$((skipped + 1))
    eval "$("$b" shellenv)"
    return
  fi
  need "installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [[ -x /opt/homebrew/bin/brew ]] || die "Homebrew install finished but /opt/homebrew/bin/brew is missing."
  eval "$(/opt/homebrew/bin/brew shellenv)"
  local zprofile="${HOME}/.zprofile"
  if ! grep -q '/opt/homebrew/bin/brew shellenv' "$zprofile" 2>/dev/null; then
    {
      echo ''
      echo '# Homebrew (added by zotero-remarkable-sync scripts/macos-m1-prereqs.sh)'
      echo 'eval "$(/opt/homebrew/bin/brew shellenv)"'
    } >>"$zprofile"
    log "  appended brew shellenv to ${zprofile}"
  fi
  ok "installed ($(brew --version | head -1))"
  installed=$((installed + 1))
}

brew_pkg_installed() {
  brew list --versions "$1" >/dev/null 2>&1
}

node_major() {
  node -p "parseInt(process.versions.node.split('.')[0], 10)" 2>/dev/null || echo 0
}

node_is_arm64() {
  local m
  m="$(node -p "process.arch" 2>/dev/null || true)"
  [[ "$m" == "arm64" ]]
}

ensure_node() {
  begin "Node.js >= ${MIN_NODE_MAJOR} (native arm64)"
  prefer_homebrew_path
  local major
  major="$(node_major)"
  if command -v node >/dev/null 2>&1 && (( major >= MIN_NODE_MAJOR )) && node_is_arm64; then
    ok "already present ($(command -v node) v$(node -v | tr -d v) $(node -p process.arch))"
    skipped=$((skipped + 1))
    return
  fi
  if command -v node >/dev/null 2>&1; then
    need "replacing Node v$(node -v 2>/dev/null | tr -d v) ($(node -p process.arch 2>/dev/null || echo unknown)) with Homebrew arm64 Node"
  else
    need "brew install node"
  fi
  if brew_pkg_installed node; then
    brew upgrade node
  else
    brew install node
  fi
  prefer_homebrew_path
  hash -r 2>/dev/null || true
  major="$(node_major)"
  (( major >= MIN_NODE_MAJOR )) || die "Node is still too old ($(node -v 2>/dev/null || echo missing)). Need >= ${MIN_NODE_MAJOR}."
  node_is_arm64 || die "Node is not arm64 ($(node -p process.arch)). Check PATH: $(command -v node)"
  ok "installed ($(command -v node) v$(node -v | tr -d v) $(node -p process.arch))"
  installed=$((installed + 1))
}

ensure_npm() {
  begin "npm (ships with Node)"
  prefer_homebrew_path
  if command -v npm >/dev/null 2>&1; then
    ok "already present ($(command -v npm) v$(npm -v))"
    skipped=$((skipped + 1))
    return
  fi
  die "npm is missing even though Node is installed. Re-run: brew reinstall node"
}

ensure_git() {
  begin "git (husky prepare script)"
  prefer_homebrew_path
  if command -v git >/dev/null 2>&1; then
    ok "already present ($(command -v git) $(git --version | awk '{print $3}'))"
    skipped=$((skipped + 1))
    return
  fi
  need "brew install git"
  brew install git
  ok "installed ($(git --version))"
  installed=$((installed + 1))
}

ensure_npm_deps() {
  begin "Project npm packages (zotero-plugin-scaffold, typescript, mammoth, …)"
  prefer_homebrew_path
  local node_v
  node_v="$(node -v | tr -d v)"
  local major="${node_v%%.*}"
  (( major >= MIN_NODE_MAJOR )) || die "Refusing npm install with Node ${node_v} (need >= ${MIN_NODE_MAJOR})."
  if [[ -d node_modules/zotero-plugin-scaffold && -d node_modules/typescript ]]; then
    ok "node_modules already present — running npm install to sync lockfile"
  else
    need "npm install"
  fi
  npm install
  ok "npm packages ready"
}

maybe_build() {
  [[ "$DO_BUILD" -eq 1 ]] || return 0
  begin "npm run build (.xpi)"
  prefer_homebrew_path
  npm run build
  local xpi
  xpi="$(ls -1 "${ROOT}/.scaffold/build/"*.xpi 2>/dev/null | head -1 || true)"
  [[ -n "$xpi" && -f "$xpi" ]] || die "Build finished but no .xpi appeared under ${ROOT}/.scaffold/build/."
  ok "$xpi ($(du -h "$xpi" | awk '{print $1}'))"
}

ensure_arm64_macos
ensure_xcode_clt
ensure_homebrew
# git before node: Command Line Tools often already provide git; brew git is
# only used as a fallback.
ensure_git
ensure_node
ensure_npm
ensure_npm_deps
maybe_build

printf '\nDone. %d installed, %d already present.\n' "$installed" "$skipped"
printf 'Next: npm run build   # writes .scaffold/build/*.xpi\n'
if [[ "$DO_BUILD" -eq 0 ]]; then
  printf '      or re-run with --build to compile the .xpi now.\n'
fi
