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

& ssh -N -L 18080:127.0.0.1:18080 -L 43121:127.0.0.1:43121 "$User@$HostName" -p $Port
exit $LASTEXITCODE
