[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$minimumNodeVersion = [version]"24.14.1"

try {
  $nodeVersion = [version]((& node --version).Trim().TrimStart("v"))
} catch {
  throw "Node.js $minimumNodeVersion or later is required."
}

if ($nodeVersion -lt $minimumNodeVersion) {
  throw "Node.js $minimumNodeVersion or later is required."
}

$databaseFile = $env:DATABASE_FILE
if ([string]::IsNullOrWhiteSpace($databaseFile)) {
  $databaseFile = Join-Path $projectRoot "data\resume-assistant.sqlite"
} elseif (-not [IO.Path]::IsPathRooted($databaseFile)) {
  $databaseFile = Join-Path $projectRoot $databaseFile
}
$databaseDirectory = Split-Path -Parent $databaseFile
New-Item -ItemType Directory -Force -Path $databaseDirectory | Out-Null
$writeProbe = Join-Path $databaseDirectory ".resume-assistant-write-$PID.tmp"
try {
  [IO.File]::WriteAllText($writeProbe, "")
} finally {
  Remove-Item -LiteralPath $writeProbe -Force -ErrorAction SilentlyContinue
}

$listeningPorts = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
foreach ($port in 43110, 43120, 18080, 43121) {
  if ($listeningPorts -contains $port) {
    throw "Required local port $port is already in use."
  }
}

$optionalVariables = @(
  "DEEPSEEK_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_TOKEN",
  "EMBEDDING_MODEL",
  "EMBEDDING_MODEL_REVISION",
  "EMBEDDING_DIMENSIONS",
  "OCR_BASE_URL",
  "OCR_API_TOKEN",
  "OCR_MODEL",
  "OCR_MODEL_REVISION"
)
$missingOptionalVariables = $optionalVariables | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) }
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
