[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$apiWorkingDirectory = Join-Path $projectRoot "apps\api"
$minimumNodeVersion = [version]"24.14.1"
Import-Module (Join-Path $PSScriptRoot "local-launch.psm1") -Force

try {
  $nodeVersion = [version]((& node --version).Trim().TrimStart("v"))
} catch {
  throw "Node.js $minimumNodeVersion or later is required."
}

if ($nodeVersion -lt $minimumNodeVersion) {
  throw "Node.js $minimumNodeVersion or later is required."
}

$effectiveEnvironment = Get-EffectiveEnvironment `
  -EnvFile (Join-Path $projectRoot ".env.local") `
  -ProcessEnvironment ([Environment]::GetEnvironmentVariables())
$databaseDirectory = Get-EffectiveDatabaseDirectory `
  -WorkingDirectory $apiWorkingDirectory `
  -Environment $effectiveEnvironment
Assert-DatabaseDirectoryWritable -Directory $databaseDirectory

$listeningPorts = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
foreach ($port in 43110, 43120, 18080, 43121) {
  if ($listeningPorts -contains $port) {
    throw "Required local port $port is already in use."
  }
}

$missingOptionalVariables = @(Get-MissingOptionalAdapterVariables -Environment $effectiveEnvironment)
if ($missingOptionalVariables.Count -gt 0) {
  Write-Output "Optional adapter variables not set:"
  $missingOptionalVariables | ForEach-Object { Write-Output $_ }
}

Push-Location $projectRoot
try {
  & corepack pnpm start:api
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
