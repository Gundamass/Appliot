[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$HostName,

  [ValidateNotNullOrEmpty()]
  [string]$User = "heqing",

  [ValidateRange(1, 65535)]
  [int]$Port = 22
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "local-launch.psm1") -Force

$sshArguments = @(Get-ModelTunnelSshArguments -HostName $HostName -User $User -Port $Port)
& ssh @sshArguments
exit $LASTEXITCODE
