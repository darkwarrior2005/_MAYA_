#!/usr/bin/env bash
#
# Installs the `maya` command on Linux or macOS.
#
#   ./install.sh                  # into ~/.local/bin
#   ./install.sh --prefix /usr/local   # somewhere else
#   ./install.sh --no-path        # install, but do not touch any shell profile
#
# What it does, in order: checks Node and pnpm, installs dependencies, builds
# the workspace, bundles a self-contained `maya`, installs that bundle's own
# runtime dependencies, and links `maya` and `maya-mcp` onto your PATH.
#
# Nothing is installed globally through npm, and nothing needs root unless you
# point --prefix at a directory that does.
set -euo pipefail

PREFIX="${HOME}/.local"
TOUCH_PATH=1

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --no-path) TOUCH_PATH=0; shift ;;
    # The comment block at the top of this file is the help text. Taken by
    # pattern rather than by line number, so editing the header cannot leave
    # `--help` printing a line of code.
    -h|--help) sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")" && pwd)"
BIN="${PREFIX}/bin"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- what has to be here already --------------------------------------------

command -v git >/dev/null 2>&1 || die "git is not on PATH. Maya drives git; install it first."
command -v node >/dev/null 2>&1 || die "node is not on PATH. Install Node 20 or newer."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  die "Node ${NODE_MAJOR} is too old. Maya needs 20 or newer (25 is what it was developed on)."
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    say "pnpm is missing; enabling it through corepack"
    corepack enable pnpm >/dev/null 2>&1 || die "corepack could not enable pnpm. Install it with: npm install -g pnpm"
  else
    die "pnpm is not on PATH. Install it with: npm install -g pnpm"
  fi
fi

# --- build ------------------------------------------------------------------

cd "${REPO}"

say "installing dependencies (this is the slow step)"
pnpm install

say "building"
pnpm build

say "bundling a self-contained maya"
pnpm package

say "installing the bundle's runtime dependencies"
# `--omit=dev` keeps this to better-sqlite3 and the Agent SDK. node-pty is
# optional and has no Linux prebuild, so a failure to build it is not fatal:
# only the `pty` transport and the terminal verification harnesses need it.
( cd "${REPO}/dist/maya" && npm install --omit=dev --no-audit --no-fund ) ||
  die "npm install failed in dist/maya"

# --- link -------------------------------------------------------------------

mkdir -p "${BIN}"
for name in maya maya-mcp; do
  target="${REPO}/dist/maya/${name}.mjs"
  [ -f "${target}" ] || die "expected ${target} after packaging, and it is not there"
  chmod +x "${target}"
  ln -sf "${target}" "${BIN}/${name}"
  say "linked ${BIN}/${name}"
done

# --- PATH -------------------------------------------------------------------

case ":${PATH}:" in
  *":${BIN}:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac

if [ "${ON_PATH}" -eq 0 ] && [ "${TOUCH_PATH}" -eq 1 ]; then
  # Appended to the profile of the shell you are actually using, with a marker
  # so running this twice does not add it twice.
  case "${SHELL##*/}" in
    zsh) PROFILE="${HOME}/.zshrc" ;;
    bash) PROFILE="${HOME}/.bashrc" ;;
    *) PROFILE="${HOME}/.profile" ;;
  esac
  MARKER="# added by Maya's install.sh"
  if ! grep -qF "${MARKER}" "${PROFILE}" 2>/dev/null; then
    printf '\n%s\nexport PATH="%s:$PATH"\n' "${MARKER}" "${BIN}" >> "${PROFILE}"
    say "added ${BIN} to PATH in ${PROFILE}"
    say "open a new shell, or: export PATH=\"${BIN}:\$PATH\""
  fi
elif [ "${ON_PATH}" -eq 0 ]; then
  say "${BIN} is not on your PATH. Add it yourself, or run without --no-path."
fi

# --- check it actually runs -------------------------------------------------

say "checking the installed command"
INSTALLED_VERSION="$("${BIN}/maya" --version 2>&1)" || die "the installed maya did not run: ${INSTALLED_VERSION}"

cat <<DONE

  Maya ${INSTALLED_VERSION} is installed.

  Try it:

    maya doctor -d .          # what is installed and logged in
    maya init ~/some-project  # prepare a project
    maya web -d ~/some-project

  Each wrapped CLI needs its own one-time login (claude, copilot, agy).
  \`maya doctor\` says which ones are missing.

DONE
