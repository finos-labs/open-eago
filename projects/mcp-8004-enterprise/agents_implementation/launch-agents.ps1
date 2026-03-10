#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Launches all MCP agent servers as background jobs.

.DESCRIPTION
    Reads every *.json file in ../agents, assigns each a port starting at
    BASE_PORT (default 9000), and starts a separate node process for each.
    Each process logs to agents_implementation/logs/<agent-name>.log.

.PARAMETER BasePort
    First port to use. Subsequent agents get BasePort+1, BasePort+2, …
    Default: 9000

.EXAMPLE
    .\launch-agents.ps1
    .\launch-agents.ps1 -BasePort 8100
#>

param(
    [int]$BasePort = 9000
)

$ErrorActionPreference = 'Stop'
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$AgentsDir  = Resolve-Path (Join-Path $ScriptDir '..\agents')
$ServerJs   = Join-Path $ScriptDir 'server.js'
$LogsDir    = Join-Path $ScriptDir 'logs'

if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir | Out-Null
}

$cards = Get-ChildItem -Path $AgentsDir -Filter '*.json' | Sort-Object Name

if ($cards.Count -eq 0) {
    Write-Error "No agent card JSON files found in $AgentsDir"
    exit 1
}

Write-Host "Found $($cards.Count) agent card(s) in $AgentsDir"
Write-Host "Base port : $BasePort"
Write-Host ""

$pids = @()

$usedPorts = @{}
$fallbackPort = $BasePort

for ($i = 0; $i -lt $cards.Count; $i++) {
    $card     = $cards[$i]
    $cardData = Get-Content $card.FullName | ConvertFrom-Json

    # Extract port from endpoint/url field in the card
    $port = $null
    $endpointField = $cardData.endpoint ?? $cardData.url ?? $cardData.baseUrl ?? $cardData.host
    if ($endpointField) {
        try {
            $uri  = [System.Uri]$endpointField
            if ($uri.Port -gt 0) { $port = $uri.Port }
        } catch {}
    }

    # Fallback: find the next unused sequential port
    if (-not $port) {
        while ($usedPorts.ContainsKey($fallbackPort)) { $fallbackPort++ }
        $port = $fallbackPort
    }

    if ($usedPorts.ContainsKey($port)) {
        Write-Warning "[$($card.Name)] Port $port conflicts with another agent — skipping."
        continue
    }
    $usedPorts[$port] = $true
    if ($port -eq $fallbackPort) { $fallbackPort++ }

    $logFile = Join-Path $LogsDir ($card.BaseName + '.log')

    $proc = Start-Process `
        -FilePath   'node' `
        -ArgumentList @($ServerJs, $card.FullName, $port) `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError  ($logFile -replace '\.log$', '.err.log') `
        -NoNewWindow `
        -PassThru

    Write-Host "Started [$($card.Name)]  port=$port  pid=$($proc.Id)  log=$logFile"
    $pids += $proc.Id
}

Write-Host ""
Write-Host "All agents started. PIDs: $($pids -join ', ')"
Write-Host "Logs are in: $LogsDir"
Write-Host ""
Write-Host "To stop all agents run:"
Write-Host "  .\stop-agents.ps1"

# Save PIDs so stop-agents.ps1 can kill them
$pids | Set-Content (Join-Path $ScriptDir 'agent-pids.txt')

