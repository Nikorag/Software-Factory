#!/usr/bin/env bash
# Software Factory installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Nikorag/Software-Factory/main/install.sh | bash
#
# What it does (nothing needs sudo, and nothing outside the places listed here is touched):
#   1. checks that macOS, git, Node 22+, Python 3.11+, uv, Spec Kit, Claude Code (signed in) and the GitHub CLI (signed in) are
#      all present, and if anything is missing prints exactly how to install it and stops before changing anything
#   2. downloads the factory into  $FACTORY_HOME/app        (default ~/.software-factory/app)
#   3. installs its dependencies and builds the dashboard
#   4. adds a `software-factory` command to  $FACTORY_BIN   (default ~/.local/bin)
# It does NOT start anything, install a login item, or ask for any credentials: run `software-factory start` and the
# dashboard walks you through the rest. Read this file first if you like: `curl -fsSL <url> | less`.
#
# Options:  --check     only check the machine's requirements, change nothing
#           --dry-run   print what would happen and change nothing
# Env:      FACTORY_HOME, FACTORY_BIN, FACTORY_REPO (git url), FACTORY_REF (tag or branch; default: the newest release, else main)
# Update later with:  software-factory update

# Everything is inside main() so a download that is cut off half way never runs a partial script.
main() {
  set -euo pipefail

  local REPO="${FACTORY_REPO:-https://github.com/Nikorag/Software-Factory.git}"
  local REF="${FACTORY_REF:-}"
  local HOME_DIR="${FACTORY_HOME:-$HOME/.software-factory}"
  local APP="$HOME_DIR/app"
  local BIN="${FACTORY_BIN:-$HOME/.local/bin}"
  local DRY=0 CHECK_ONLY=0
  for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --check) CHECK_ONLY=1 ;; esac; done

  say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
  warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
  die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
  run()  { if [ "$DRY" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }

  if [ "$DRY" = 1 ]; then say "Software Factory installer (dry run: nothing will be changed)"; else say "Software Factory installer"; fi

  # Which version: FACTORY_REF if given, else the newest release tag (v*), else main (before the first release).
  if [ -z "$REF" ]; then
    REF="$(git ls-remote --tags --refs "$REPO" 'v*' 2>/dev/null | sed 's#.*refs/tags/##' | sort -V | tail -1 || true)"
    REF="${REF:-main}"
  fi
  say "version: $REF"

  # 1. preflight: everything the factory drives must already be installed and signed in. Nothing is downloaded or changed until all of it passes.
  local OK=() BAD=() HOWTO=()
  pass() { OK+=("$1"); }
  need() { BAD+=("$1"); HOWTO+=("$2"); } # need "what is wrong" "how to fix it"
  have() { command -v "$1" >/dev/null 2>&1; }

  if [ "$(uname -s)" = "Darwin" ]; then pass "macOS"; else need "macOS is required (found $(uname -s))" "Project commands run inside macOS sandbox-exec and the factory refuses to run them unconfined. There is no Linux or Windows support yet."; fi
  if have git; then pass "git"; else need "git is not installed" "xcode-select --install"; fi
  if have node; then
    local NODE_MAJOR; NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$NODE_MAJOR" -ge 22 ]; then pass "Node.js $(node -v)"; else need "Node.js 22 or newer is required (found $(node -v))" "brew install node   (or https://nodejs.org)"; fi
  else need "Node.js is not installed" "brew install node   (or https://nodejs.org)"; fi
  # Spec Kit is a Python tool. uv provisions its own Python, so an old system python is fine when uv is present.
  if have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then pass "Python $(python3 -c 'import platform; print(platform.python_version())')"
  elif have uv; then pass "Python (uv provides 3.11+ for Spec Kit)"
  elif have python3; then need "Python 3.11 or newer is required for Spec Kit (found $(python3 --version 2>&1))" "brew install python@3.12   (or install uv, which provides its own Python)"
  else need "Python 3 is not installed (Spec Kit needs it)" "brew install python@3.12   (or install uv, which provides its own Python)"; fi
  if have uv; then pass "uv"; else need "uv is not installed (it installs Spec Kit)" "brew install uv   (or: curl -LsSf https://astral.sh/uv/install.sh | sh)"; fi
  if have specify || [ -x "$HOME/.local/bin/specify" ]; then pass "Spec Kit (specify)"; else need "Spec Kit ('specify') is not installed" "uv tool install specify-cli   (then make sure ~/.local/bin is on your PATH: uv tool update-shell)"; fi
  if have claude; then
    if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then pass "Claude Code (signed in)"
    else need "Claude Code is installed but not signed in" "Run 'claude', then type /login and sign in with your Claude subscription. The factory uses that login: no API key."; fi
  else need "Claude Code is not installed" "curl -fsSL https://claude.ai/install.sh | bash   (or: npm install -g @anthropic-ai/claude-code). Then run 'claude' and /login."; fi
  if have gh; then
    if gh auth status >/dev/null 2>&1; then pass "GitHub CLI (signed in)"; else need "GitHub CLI is installed but not signed in" "gh auth login   (run it again for each GitHub account you want to use)"; fi
  else need "GitHub CLI ('gh') is not installed" "brew install gh   then   gh auth login"; fi

  say "checking your machine"
  local i
  for i in "${OK[@]:-}"; do [ -n "$i" ] && printf '   \033[32m✓\033[0m %s\n' "$i"; done
  if [ "${#BAD[@]}" -gt 0 ]; then
    for i in "${!BAD[@]}"; do printf '   \033[31m✗\033[0m %s\n       fix: %s\n' "${BAD[$i]}" "${HOWTO[$i]}"; done
    printf '\n'
    die "${#BAD[@]} requirement(s) missing. Nothing was installed or changed. Fix the items above, then run this installer again."
  fi
  say "all requirements are in place"
  [ "$CHECK_ONLY" = 1 ] && exit 0
  if ! have pnpm; then
    say "pnpm not found: installing it with npm (no sudo; into your npm prefix)"
    run npm install -g pnpm || die "could not install pnpm. Install it yourself (https://pnpm.io/installation) and re-run."
  fi

  # 2. download (or update an earlier install: fast-forward only, local changes are never overwritten)
  if [ -d "$APP/.git" ]; then
    say "updating the existing install in $APP"
    say "tip: next time, just run  software-factory update"
    run git -C "$APP" fetch --quiet --tags origin
    if git -C "$APP" show-ref --verify --quiet "refs/tags/$REF"; then run git -C "$APP" checkout --quiet --detach "$REF" || die "$APP has local changes; resolve that (or remove it) and re-run."
    else run git -C "$APP" merge --ff-only "origin/$REF" || die "$APP has local changes or diverged; resolve that (or remove it) and re-run."; fi
  else
    say "downloading the factory into $APP"
    run mkdir -p "$HOME_DIR"
    run git clone --quiet --depth 1 --branch "$REF" "$REPO" "$APP"
  fi

  # 3. dependencies and dashboard
  say "installing dependencies (this takes a minute)"
  if [ "$DRY" = 1 ]; then run pnpm --dir "$APP" install --frozen-lockfile; else (cd "$APP" && pnpm install --frozen-lockfile --silent); fi
  say "building the dashboard"
  if [ "$DRY" = 1 ]; then run pnpm --dir "$APP" web:build; else (cd "$APP" && pnpm web:build >/dev/null); fi

  # 4. the command
  say "adding the software-factory command to $BIN"
  if [ "$DRY" = 1 ]; then
    run write "$BIN/software-factory"
  else
    mkdir -p "$BIN"
    cat > "$BIN/software-factory" <<LAUNCHER
#!/usr/bin/env bash
# Generated by the Software Factory installer. Runs the CLI from the install directory.
exec pnpm --dir "$APP" --silent factory "\$@"
LAUNCHER
    chmod +x "$BIN/software-factory"
  fi

  if [ "$DRY" = 1 ]; then say "dry run complete: nothing was changed."; else say "installed."; fi
  case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on your PATH. Add this to your shell profile:  export PATH=\"$BIN:\$PATH\"" ;; esac
  cat <<DONE

Next:
  software-factory start      # starts the factory and opens the dashboard's setup wizard
It is safe to stop with Ctrl-C at any time. Nothing runs at login unless you later choose 'software-factory launchd:install'.
Your settings and data live in $HOME_DIR ; uninstall = delete $APP and $BIN/software-factory.
DONE
}

main "$@"
