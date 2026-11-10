<#
.SYNOPSIS
  Installs the `maya` command on Windows.

.DESCRIPTION
  Checks Node and pnpm, installs dependencies, builds the workspace, bundles a
  self-contained `maya`, installs that bundle's own runtime dependencies, and
  puts `maya` and `maya-mcp` shims on your PATH.

  Nothing is installed globally through npm, nothing needs an administrator,
  and the only thing it changes outside this folder is your *user* PATH — which
  -NoPath skips.

.PARAMETER Prefix
  Where the shims go. Defaults to %LOCALAPPDATA%\Programs\maya.

.PARAMETER NoPath
  Install the shims but leave PATH alone.

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -NoPath
#>
[CmdletBinding()]
param(
  [string] $Prefix = (Join-Path $env:LOCALAPPDATA "Programs\maya"),
  [switch] $NoPath
)

$ErrorActionPreference = "Stop"

function Say($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Die($message) { Write-Host "error: $message" -ForegroundColor Red; exit 1 }

$repo = $PSScriptRoot
$bin = Join-Path $Prefix "bin"

# --- what has to be here already --------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Die "git is not on PATH. Maya drives git; install Git for Windows first."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "node is not on PATH. Install Node 20 or newer."
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) {
  Die "Node $nodeMajor is too old. Maya needs 20 or newer (25 is what it was developed on)."
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    Say "pnpm is missing; enabling it through corepack"
    corepack enable pnpm | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "corepack could not enable pnpm. Install it with: npm install -g pnpm" }
  } else {
    Die "pnpm is not on PATH. Install it with: npm install -g pnpm"
  }
}

# Claude Code needs a bash on Windows; the others do not. Worth saying now
# rather than at the first run, when it looks like Maya is broken.
if (-not (Test-Path "C:\Program Files\Git\bin\bash.exe")) {
  Say "note: Git for Windows' bash was not at the usual path. Claude Code needs it on Windows; set CLAUDE_CODE_GIT_BASH_PATH if yours is elsewhere."
}

# --- build ------------------------------------------------------------------

Push-Location $repo
try {
  Say "installing dependencies (this is the slow step)"
  pnpm install
  if ($LASTEXITCODE -ne 0) { Die "pnpm install failed" }

  Say "building"
  pnpm build
  if ($LASTEXITCODE -ne 0) { Die "pnpm build failed" }

  Say "bundling a self-contained maya"
  pnpm package
  if ($LASTEXITCODE -ne 0) { Die "pnpm package failed" }

  Say "installing the bundle's runtime dependencies"
  Push-Location (Join-Path $repo "dist\maya")
  try {
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Die "npm install failed in dist\maya" }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}

# --- shims ------------------------------------------------------------------

if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin -Force | Out-Null }

# A .cmd shim rather than a symlink: creating a symlink on Windows needs
# either Developer Mode or an elevated shell, and a two-line batch file needs
# neither. `%~dp0` keeps it working if the whole folder is moved.
foreach ($name in @("maya", "maya-mcp")) {
  $entry = Join-Path $repo "dist\maya\$name.mjs"
  if (-not (Test-Path $entry)) { Die "expected $entry after packaging, and it is not there" }

  # `node "<entry>" %*` — the quotes matter, because the repository path may
  # contain spaces.
  @(
    '@echo off',
    "node `"$entry`" %*"
  ) | Set-Content -Path (Join-Path $bin "$name.cmd") -Encoding ascii

  # And a PowerShell shim, so `maya` works in a pwsh session that does not
  # fall back to .cmd resolution.
  @(
    "#!/usr/bin/env pwsh",
    "node `"$entry`" @args",
    'exit $LASTEXITCODE'
  ) | Set-Content -Path (Join-Path $bin "$name.ps1") -Encoding utf8

  Say "installed $bin\$name.cmd"
}

# --- PATH -------------------------------------------------------------------

$onPath = ($env:PATH -split ';') -contains $bin

if (-not $onPath -and -not $NoPath) {
  # User PATH only. Nothing here needs the machine-wide one, and editing that
  # would need an administrator.
  $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
  if (-not (($userPath -split ';') -contains $bin)) {
    $updated = if ([string]::IsNullOrEmpty($userPath)) { $bin } else { "$userPath;$bin" }
    [Environment]::SetEnvironmentVariable("PATH", $updated, "User")
    Say "added $bin to your user PATH"
    Say "open a new terminal for that to take effect"
  }
  # Make it work in this session too, so the check below is a real check.
  $env:PATH = "$env:PATH;$bin"
} elseif (-not $onPath) {
  Say "$bin is not on your PATH. Add it yourself, or run without -NoPath."
  $env:PATH = "$env:PATH;$bin"
}

# --- check it actually runs -------------------------------------------------

Say "checking the installed command"
$version = & (Join-Path $bin "maya.cmd") --version 2>&1
if ($LASTEXITCODE -ne 0) { Die "the installed maya did not run: $version" }

Write-Host ""
Write-Host "  Maya $version is installed." -ForegroundColor Green
Write-Host ""
Write-Host "  Try it:"
Write-Host ""
Write-Host "    maya doctor -d .              # what is installed and logged in"
Write-Host "    maya init C:\some-project     # prepare a project"
Write-Host "    maya web -d C:\some-project"
Write-Host ""
Write-Host "  Each wrapped CLI needs its own one-time login (claude, copilot, agy)."
Write-Host "  ``maya doctor`` says which ones are missing."
Write-Host ""
