#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Stops all MCP agent servers previously started by launch-agents.ps1.
#>

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PidFile   = Join-Path $ScriptDir 'agent-pids.txt'

if (-not (Test-Path $PidFile)) {
    Write-Warning "No agent-pids.txt found. Nothing to stop."
    exit 0
}

$pids = Get-Content $PidFile | Where-Object { $_ -match '^\d+$' }

foreach ($agentPid in $pids) {
    try {
        $proc = Get-Process -Id $agentPid -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $agentPid -Force
            Write-Host "Stopped pid $agentPid ($($proc.Name))"
        } else {
            Write-Host "Process $agentPid already gone."
        }
    } catch {
        Write-Warning "Could not stop pid ${agentPid}: $_"
    }
}

Remove-Item $PidFile -Force
Write-Host "Done."

