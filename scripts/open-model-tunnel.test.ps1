Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "local-launch.psm1") -Force

$script:failures = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Sequence {
  param([string[]]$Expected, [string[]]$Actual, [string]$Message)
  if (($Expected -join "`n") -ne ($Actual -join "`n")) { throw $Message }
}

function Assert-Rejected {
  param([scriptblock]$Action, [string]$Message)
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw $Message }
}

function Invoke-Case {
  param([string]$Name, [scriptblock]$Test)
  try {
    & $Test
    Write-Output "PASS: $Name"
  } catch {
    $script:failures++
    Write-Error "FAIL: $Name - $($_.Exception.Message)"
  }
}

Invoke-Case "builds exact separate SSH arguments for DNS and IPv4" {
  $expected = @(
    "-N", "-L", "18080:127.0.0.1:18080", "-L", "43121:127.0.0.1:43121",
    "heqing@models.example.com", "-p", "2222"
  )
  Assert-Sequence $expected (Get-ModelTunnelSshArguments -HostName "models.example.com" -User "heqing" -Port 2222) "DNS SSH arguments were not exact."
  $ipv4 = Get-ModelTunnelSshArguments -HostName "192.0.2.10" -User "deploy_user" -Port 22
  Assert-True ($ipv4 -contains "deploy_user@192.0.2.10") "IPv4 host identity was not preserved as one argument."
}

Invoke-Case "accepts raw and bracketed IPv6 safely" {
  $raw = Get-ModelTunnelSshArguments -HostName "2001:db8::10" -User "heqing" -Port 22
  $bracketed = Get-ModelTunnelSshArguments -HostName "[2001:db8::10]" -User "heqing" -Port 22
  Assert-True ($raw -contains "heqing@2001:db8::10") "Raw IPv6 host was rejected or rewritten incorrectly."
  Assert-True ($bracketed -contains "heqing@2001:db8::10") "Bracketed IPv6 host was not normalized safely."
}

Invoke-Case "rejects unsafe or malformed hosts" {
  foreach ($hostValue in @(
    "-models.example.com", "models example.com", "models`nexample.com", "user@models.example.com",
    ".models.example.com", "models..example.com", "bad_label.example.com", "999.1.1.1", "[2001:db8::10"
  )) {
    Assert-Rejected { Get-ModelTunnelSshArguments -HostName $hostValue -User "heqing" -Port 22 } "Unsafe or malformed host was accepted."
  }
}

Invoke-Case "rejects unsafe or malformed users and ports" {
  foreach ($userValue in @("-root", "bad user", "bad`nuser", "user@domain", ".leading", "user/option")) {
    Assert-Rejected { Get-ModelTunnelSshArguments -HostName "models.example.com" -User $userValue -Port 22 } "Unsafe or malformed user was accepted."
  }
  Assert-Rejected { Get-ModelTunnelSshArguments -HostName "models.example.com" -User "heqing" -Port 0 } "Port zero was accepted."
  Assert-Rejected { Get-ModelTunnelSshArguments -HostName "models.example.com" -User "heqing" -Port 65536 } "Port above 65535 was accepted."
}

Invoke-Case "tunnel script splats validated arguments without expression evaluation" {
  $scriptText = Get-Content -Raw (Join-Path $PSScriptRoot "open-model-tunnel.ps1")
  Assert-True ($scriptText -match '&\s+ssh\s+@sshArguments') "Tunnel script does not invoke ssh with a separate argument array."
  Assert-True ($scriptText -notmatch 'Invoke-Expression') "Tunnel script uses expression evaluation."
}

if ($script:failures -gt 0) {
  throw "$script:failures PowerShell test case(s) failed."
}

Write-Output "All model tunnel PowerShell tests passed."
