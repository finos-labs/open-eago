#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Full stack launcher: compiles contracts, starts Hardhat node, runs the
    test suite, then spawns MCP servers and oracle bridges.

.DESCRIPTION
    Steps:
      1. npx hardhat compile
      2. npx hardhat node  (background, waits until RPC is ready)
      3. npm test  (exercises all contracts in-process; deploy scripts are in progress)
      4. node agents_implementation/launch-agents.js + launch-bridges.js
         (foreground – Ctrl-C shuts everything down)

    To wire bridges against a live deployed network, set env vars before running:
      IDENTITY_REGISTRY_ADDRESS, AUTONOMY_BOUNDS_ADDRESS,
      ACTION_PERMIT_ADDRESS, TRACE_LOG_ADDRESS, ORACLE_PRIVATE_KEY, RPC_URL

.PARAMETER SkipCompile
    Skip the compile step (if contracts are already compiled).

.PARAMETER SkipTest
    Skip the npm test step.

.PARAMETER BasePort
    Passed through to launch-agents.js. Default: use ports from agent cards.

.EXAMPLE
    .\start.ps1
    .\start.ps1 -SkipCompile
    .\start.ps1 -SkipCompile -SkipTest
#>

param(
    [switch]$SkipCompile,
    [switch]$SkipTest,
    [int]$BasePort = 0
)

$ErrorActionPreference = 'Stop'
$Root   = $PSScriptRoot
$AgentsImpl = Join-Path $Root 'agents_implementation'

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "══════════════════════════════════════════════" -ForegroundColor Cyan
}

function Wait-Port([int]$port, [int]$timeoutSec = 30) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect('127.0.0.1', $port)
            $tcp.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

# ── Track child processes for cleanup ────────────────────────────────────────
$hardhatProc = $null

function Stop-All {
    Write-Host "`nCleaning up…" -ForegroundColor Yellow
    if ($hardhatProc -and -not $hardhatProc.HasExited) {
        Stop-Process -Id $hardhatProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped Hardhat node (pid $($hardhatProc.Id))"
    }
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 – Compile
# ─────────────────────────────────────────────────────────────────────────────
if (-not $SkipCompile) {
    Write-Step "1/4  Compiling contracts"
    Push-Location $Root
    npx hardhat compile
    if ($LASTEXITCODE -ne 0) { Write-Error "Compile failed."; exit 1 }
    Pop-Location
} else {
    Write-Host "`n[skip] Compile step skipped." -ForegroundColor DarkGray
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 – Start Hardhat node in background
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "2/4  Starting Hardhat node"

$hardhatLog = Join-Path $Root 'hardhat-node.log'
$hardhatProc = Start-Process `
    -FilePath   'npx' `
    -ArgumentList @('hardhat', 'node') `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $hardhatLog `
    -RedirectStandardError  ($hardhatLog -replace '\.log$', '.err.log') `
    -NoNewWindow `
    -PassThru

Write-Host "  Hardhat node pid=$($hardhatProc.Id)  log=$hardhatLog"
Write-Host "  Waiting for RPC on port 8545…" -NoNewline

if (-not (Wait-Port 8545 60)) {
    Write-Host " TIMEOUT" -ForegroundColor Red
    Stop-All; exit 1
}
Write-Host " ready." -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 – Run test suite (exercises all contracts in-process)
# ─────────────────────────────────────────────────────────────────────────────
if (-not $SkipTest) {
    Write-Step "3/4  Running contract test suite"
    Push-Location $Root
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Tests failed."
        Stop-All; exit 1
    }
    Pop-Location
} else {
    Write-Host "`n[skip] Test step skipped." -ForegroundColor DarkGray
}

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 – Launch MCP servers + oracle bridges (foreground – Ctrl-C stops all)
# ─────────────────────────────────────────────────────────────────────────────
Write-Step "4/4  Launching MCP agent servers & oracle bridges"

# Hardhat account #0 private key (default for local dev — do not use in production)
$oraclePrivKey = if ($env:ORACLE_PRIVATE_KEY) { $env:ORACLE_PRIVATE_KEY } `
                 else { "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" }
$rpcUrl        = if ($env:RPC_URL) { $env:RPC_URL } else { "http://127.0.0.1:8545" }

# Build optional bridge flags from env vars
$bridgeArgs = @(
    'agents_implementation/launch-bridges.js',
    '--rpc',     $rpcUrl,
    '--privkey', $oraclePrivKey
)
if ($env:IDENTITY_REGISTRY_ADDRESS) { $bridgeArgs += '--identity-registry'; $bridgeArgs += $env:IDENTITY_REGISTRY_ADDRESS }
if ($env:AUTONOMY_BOUNDS_ADDRESS)   { $bridgeArgs += '--autonomy-bounds';   $bridgeArgs += $env:AUTONOMY_BOUNDS_ADDRESS }
if ($env:ACTION_PERMIT_ADDRESS)     { $bridgeArgs += '--action-permit';     $bridgeArgs += $env:ACTION_PERMIT_ADDRESS }
if ($env:TRACE_LOG_ADDRESS)         { $bridgeArgs += '--trace-log';         $bridgeArgs += $env:TRACE_LOG_ADDRESS }

Write-Host "  Launching bridges (logs → agents_implementation/logs/)" -ForegroundColor DarkCyan
$bridgeProc = Start-Process -FilePath 'node' `
    -ArgumentList $bridgeArgs `
    -WorkingDirectory $Root `
    -RedirectStandardOutput (Join-Path $AgentsImpl 'logs/bridges.log') `
    -RedirectStandardError  (Join-Path $AgentsImpl 'logs/bridges.err.log') `
    -NoNewWindow -PassThru

$launchArgs = @("agents_implementation/launch-agents.js")
if ($BasePort -gt 0) { $launchArgs += "--base-port"; $launchArgs += "$BasePort" }

try {
    Push-Location $Root
    node @launchArgs
} finally {
    Pop-Location
    if ($bridgeProc -and -not $bridgeProc.HasExited) {
        Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  Stopped bridges (pid $($bridgeProc.Id))"
    }
    Stop-All
}

