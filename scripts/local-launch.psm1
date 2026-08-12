Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-LocalEnvFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  $values = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }

  $lineNumber = 0
  foreach ($rawLine in [IO.File]::ReadAllLines($Path)) {
    $lineNumber++
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) { continue }
    if ($line.StartsWith("export ", [StringComparison]::Ordinal)) {
      $line = $line.Substring(7).TrimStart()
    }

    $match = [regex]::Match($line, '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $match.Success) {
      throw "Invalid .env.local syntax at line $lineNumber."
    }

    $name = $match.Groups[1].Value
    $rawValue = $match.Groups[2].Value
    if ($rawValue.StartsWith("'")) {
      $quoted = [regex]::Match($rawValue, "^'([^']*)'\s*(?:#.*)?$")
      if (-not $quoted.Success) { throw "Invalid .env.local syntax at line $lineNumber." }
      $value = $quoted.Groups[1].Value
    } elseif ($rawValue.StartsWith('"')) {
      $quoted = [regex]::Match($rawValue, '^"([^"]*)"\s*(?:#.*)?$')
      if (-not $quoted.Success) { throw "Invalid .env.local syntax at line $lineNumber." }
      $value = $quoted.Groups[1].Value
    } else {
      $commentIndex = $rawValue.IndexOf("#", [StringComparison]::Ordinal)
      $value = if ($commentIndex -ge 0) { $rawValue.Substring(0, $commentIndex).TrimEnd() } else { $rawValue.TrimEnd() }
    }
    $values[$name] = $value
  }

  return $values
}

function Get-EffectiveEnvironment {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$EnvFile,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ProcessEnvironment
  )

  $effective = @{}
  $fileValues = Read-LocalEnvFile -Path $EnvFile
  foreach ($name in $fileValues.Keys) {
    $effective[[string]$name] = [string]$fileValues[$name]
  }
  foreach ($name in $ProcessEnvironment.Keys) {
    $effective[[string]$name] = [string]$ProcessEnvironment[$name]
  }
  return $effective
}

function Get-EffectiveDatabaseDirectory {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Environment
  )

  $databaseFile = if ($Environment.Contains("DATABASE_FILE")) {
    [string]$Environment["DATABASE_FILE"]
  } else {
    "data/resume-assistant.sqlite"
  }
  if ([string]::IsNullOrWhiteSpace($databaseFile)) {
    throw "Invalid configuration: DATABASE_FILE"
  }
  $resolvedFile = if ([IO.Path]::IsPathRooted($databaseFile)) {
    [IO.Path]::GetFullPath($databaseFile)
  } else {
    [IO.Path]::GetFullPath((Join-Path $WorkingDirectory $databaseFile))
  }
  return [IO.Path]::GetDirectoryName($resolvedFile)
}

function Get-MissingOptionalAdapterVariables {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Environment)

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
  foreach ($name in $optionalVariables) {
    if (-not $Environment.Contains($name) -or [string]::IsNullOrWhiteSpace([string]$Environment[$name])) {
      Write-Output $name
    }
  }
}

function Assert-DatabaseDirectoryWritable {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Directory)

  $writeProbe = Join-Path $Directory ".resume-assistant-write-$PID.tmp"
  try {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    [IO.File]::WriteAllText($writeProbe, "")
  } catch {
    throw "Database directory is not writable: DATABASE_FILE"
  } finally {
    Remove-Item -LiteralPath $writeProbe -Force -ErrorAction SilentlyContinue
  }
}

function Get-ModelTunnelSshArguments {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$User,
    [Parameter(Mandatory = $true)][int]$Port
  )

  if ([string]::IsNullOrWhiteSpace($HostName) -or $HostName -match '[\s\x00-\x1F\x7F]' -or $HostName.StartsWith("-")) {
    throw "Invalid SSH host name."
  }
  if ([string]::IsNullOrWhiteSpace($User) -or $User -match '[\s\x00-\x1F\x7F]' -or $User.StartsWith("-") -or $User -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') {
    throw "Invalid SSH user name."
  }
  if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Invalid SSH port."
  }

  $normalizedHost = $HostName
  if ($HostName.StartsWith("[") -or $HostName.EndsWith("]")) {
    if (-not ($HostName.StartsWith("[") -and $HostName.EndsWith("]"))) {
      throw "Invalid SSH host name."
    }
    $normalizedHost = $HostName.Substring(1, $HostName.Length - 2)
  }

  $parsedAddress = $null
  $isIpAddress = [Net.IPAddress]::TryParse($normalizedHost, [ref]$parsedAddress)
  if ($isIpAddress -and $parsedAddress.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
    if ($normalizedHost -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') {
      throw "Invalid SSH host name."
    }
  } elseif (-not $isIpAddress) {
    if ($normalizedHost.Contains(":") -or $normalizedHost -match '^\d+(?:\.\d+){3}$') {
      throw "Invalid SSH host name."
    }
    $dnsName = $normalizedHost.TrimEnd(".")
    if ($dnsName.Length -eq 0 -or $dnsName.Length -gt 253) {
      throw "Invalid SSH host name."
    }
    foreach ($label in $dnsName.Split(".")) {
      if ($label.Length -gt 63 -or $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') {
        throw "Invalid SSH host name."
      }
    }
  }

  return @(
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", "18080:127.0.0.1:18080",
    "-L", "43121:127.0.0.1:43121",
    "$User@$normalizedHost",
    "-p", [string]$Port
  )
}

Export-ModuleMember -Function `
  Get-EffectiveEnvironment, `
  Get-EffectiveDatabaseDirectory, `
  Get-MissingOptionalAdapterVariables, `
  Assert-DatabaseDirectoryWritable, `
  Get-ModelTunnelSshArguments
