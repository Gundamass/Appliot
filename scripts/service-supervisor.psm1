Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:ServiceNames = @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")
$script:ServiceStates = @("stopped", "starting", "ready", "degraded", "retrying", "failed")

function Get-ObjectPropertyNames {
  param([Parameter(Mandatory = $true)]$Value)
  return @($Value.PSObject.Properties | ForEach-Object { $_.Name })
}

function Assert-ExactProperties {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = @(Get-ObjectPropertyNames -Value $Value | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if (($actual -join "`n") -ne ($wanted -join "`n")) {
    throw "$Label has an invalid shape."
  }
}

function Test-SafeSshHost {
  param([Parameter(Mandatory = $true)][string]$HostName)
  if ([string]::IsNullOrWhiteSpace($HostName) -or $HostName -match '[\s\x00-\x1F\x7F]' -or $HostName.StartsWith("-")) {
    return $false
  }
  $normalized = $HostName
  if ($HostName.StartsWith("[") -or $HostName.EndsWith("]")) {
    if (-not ($HostName.StartsWith("[") -and $HostName.EndsWith("]"))) { return $false }
    $normalized = $HostName.Substring(1, $HostName.Length - 2)
  }
  $address = $null
  if ([Net.IPAddress]::TryParse($normalized, [ref]$address)) { return $true }
  if ($normalized.Length -gt 253 -or $normalized.Contains(":") -or $normalized.Contains("..")) { return $false }
  foreach ($label in $normalized.TrimEnd(".").Split(".")) {
    if ($label.Length -lt 1 -or $label.Length -gt 63 -or $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') {
      return $false
    }
  }
  return $true
}

function Read-ServiceConfig {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Service configuration is invalid."
  }
  if ($null -eq $value -or $value -is [Array]) { throw "Service configuration is invalid." }
  Assert-ExactProperties -Value $value -Expected @("sshHost", "sshUser", "sshPort", "remoteRoot") -Label "Service configuration"

  if ($value.sshHost -isnot [string] -or -not (Test-SafeSshHost -HostName $value.sshHost)) {
    throw "Service configuration contains an invalid SSH host."
  }
  if ($value.sshUser -isnot [string] -or $value.sshUser -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' -or $value.sshUser.StartsWith("-")) {
    throw "Service configuration contains an invalid SSH user."
  }
  $port = 0
  if (-not [int]::TryParse([string]$value.sshPort, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "Service configuration contains an invalid SSH port."
  }
  if ($value.remoteRoot -isnot [string] -or $value.remoteRoot -notmatch '^/[A-Za-z0-9._/-]+$' -or $value.remoteRoot -match '(^|/)\.\.(/|$)') {
    throw "Service configuration contains an invalid remote root."
  }

  return [pscustomobject]@{
    sshHost = [string]$value.sshHost
    sshUser = [string]$value.sshUser
    sshPort = $port
    remoteRoot = [string]$value.remoteRoot.TrimEnd("/")
  }
}

function Get-RetryDelaySeconds {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][int]$FailureCount)
  if ($FailureCount -le 0) { return 0 }
  $delays = @(2, 5, 10, 30, 60)
  return $delays[[Math]::Min($FailureCount - 1, $delays.Count - 1)]
}

function Protect-LogText {
  [CmdletBinding()]
  param(
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Text,
    [string[]]$SecretValues = @()
  )
  $protected = $Text
  $protected = [regex]::Replace($protected, '(?im)(Authorization\s*:\s*Bearer\s+)[^\s]+', '$1[REDACTED]')
  $secretAssignmentPattern = '(?im)([A-Za-z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)[A-Za-z0-9_]*\s*=\s*)(''(?:[^'']*)''|"(?:[^\"]*)"|[^\s]+)'
  $protected = [regex]::Replace($protected, $secretAssignmentPattern, '$1[REDACTED]')
  foreach ($secret in $SecretValues) {
    if (-not [string]::IsNullOrEmpty($secret)) {
      $protected = $protected.Replace($secret, "[REDACTED]")
    }
  }
  return $protected
}

function Rotate-ServiceLog {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][long]$MaxBytes,
    [Parameter(Mandatory = $true)][int]$Backups
  )
  if ($MaxBytes -lt 1 -or $Backups -lt 1 -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  if ((Get-Item -LiteralPath $Path).Length -lt $MaxBytes) { return }
  $oldest = "$Path.$Backups"
  Remove-Item -LiteralPath $oldest -Force -ErrorAction SilentlyContinue
  for ($index = $Backups - 1; $index -ge 1; $index--) {
    $source = "$Path.$index"
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      Move-Item -LiteralPath $source -Destination "$Path.$($index + 1)" -Force
    }
  }
  Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
}

function Write-ServiceLog {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Message,
    [long]$MaxBytes = 10MB,
    [int]$Backups = 5,
    [string[]]$SecretValues = @()
  )
  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrEmpty($directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  Rotate-ServiceLog -Path $Path -MaxBytes $MaxBytes -Backups $Backups
  $safeMessage = Protect-LogText -Text $Message -SecretValues $SecretValues
  $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString("o")), $safeMessage
  Add-Content -LiteralPath $Path -Encoding UTF8 -Value $line
}

function New-ServiceStatusRecord {
  return [pscustomobject]@{
    state = "stopped"
    restartCount = 0
    failureCount = 0
    processId = $null
    commandIdentity = $null
    lastSuccessAt = $null
    lastError = $null
    nextRetryAt = $null
  }
}

function New-ServiceRuntimeState {
  [CmdletBinding()]
  param([ValidateSet("running", "stopped")][string]$DesiredState = "stopped")
  return [pscustomobject]@{
    schemaVersion = 1
    desiredState = $DesiredState
    supervisorPid = 0
    updatedAt = [DateTime]::UtcNow.ToString("o")
    services = [pscustomobject]@{
      remoteOcr = New-ServiceStatusRecord
      remoteEmbedding = New-ServiceStatusRecord
      tunnel = New-ServiceStatusRecord
      api = New-ServiceStatusRecord
      web = New-ServiceStatusRecord
    }
  }
}

function Assert-ServiceStatusRecord {
  param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Label)
  Assert-ExactProperties -Value $Value -Expected @("state", "restartCount", "failureCount", "processId", "commandIdentity", "lastSuccessAt", "lastError", "nextRetryAt") -Label $Label
  if ($script:ServiceStates -notcontains [string]$Value.state) { throw "$Label contains an invalid state." }
  if ($Value.restartCount -isnot [int] -and $Value.restartCount -isnot [long]) { throw "$Label contains an invalid restart count." }
  if ([long]$Value.restartCount -lt 0) { throw "$Label contains an invalid restart count." }
  if (($Value.failureCount -isnot [int] -and $Value.failureCount -isnot [long]) -or [long]$Value.failureCount -lt 0) { throw "$Label contains an invalid failure count." }
  if ($null -ne $Value.processId -and ([long]$Value.processId -lt 1)) { throw "$Label contains an invalid process ID." }
  foreach ($name in @("commandIdentity", "lastSuccessAt", "lastError", "nextRetryAt")) {
    if ($null -ne $Value.$name -and $Value.$name -isnot [string]) { throw "$Label contains an invalid $name value." }
  }
}

function Assert-RuntimeState {
  param([Parameter(Mandatory = $true)]$State)
  if ($null -eq $State -or $State -is [Array]) { throw "Runtime state is invalid." }
  Assert-ExactProperties -Value $State -Expected @("schemaVersion", "desiredState", "supervisorPid", "updatedAt", "services") -Label "Runtime state"
  if ([int]$State.schemaVersion -ne 1) { throw "Runtime state schema is unsupported." }
  if (@("running", "stopped") -notcontains [string]$State.desiredState) { throw "Runtime state desired state is invalid." }
  if ([long]$State.supervisorPid -lt 0) { throw "Runtime state supervisor PID is invalid." }
  $parsedTime = [DateTime]::MinValue
  if ($State.updatedAt -isnot [string] -or -not [DateTime]::TryParse([string]$State.updatedAt, [ref]$parsedTime)) {
    throw "Runtime state timestamp is invalid."
  }
  Assert-ExactProperties -Value $State.services -Expected $script:ServiceNames -Label "Runtime services"
  foreach ($serviceName in $script:ServiceNames) {
    Assert-ServiceStatusRecord -Value $State.services.$serviceName -Label "Runtime service $serviceName"
  }
}

function Read-RuntimeState {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $state = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Runtime state is invalid."
  }
  Assert-RuntimeState -State $state
  return $state
}

function Write-RuntimeState {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$State)
  Assert-RuntimeState -State $State
  $State.updatedAt = [DateTime]::UtcNow.ToString("o")
  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrEmpty($directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$Path.$([guid]::NewGuid().ToString('N')).bak"
  try {
    $State | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      [IO.File]::Replace($temporary, $Path, $backup)
    } else {
      [IO.File]::Move($temporary, $Path)
    }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

function Test-OwnedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedCommandFragment
  )
  if ($ProcessId -lt 1 -or [string]::IsNullOrWhiteSpace($ExpectedCommandFragment)) { return $false }
  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  } catch {
    return $false
  }
  if ($null -eq $process -or [string]::IsNullOrEmpty([string]$process.CommandLine)) { return $false }
  return ([string]$process.CommandLine).IndexOf($ExpectedCommandFragment, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Assert-ServiceConfigValue {
  param([Parameter(Mandatory = $true)]$Config)
  Assert-ExactProperties -Value $Config -Expected @("sshHost", "sshUser", "sshPort", "remoteRoot") -Label "Service configuration"
  if ($Config.sshHost -isnot [string] -or -not (Test-SafeSshHost -HostName $Config.sshHost)) {
    throw "Service configuration contains an invalid SSH host."
  }
  if ($Config.sshUser -isnot [string] -or $Config.sshUser -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' -or $Config.sshUser.StartsWith("-")) {
    throw "Service configuration contains an invalid SSH user."
  }
  $port = 0
  if (-not [int]::TryParse([string]$Config.sshPort, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    throw "Service configuration contains an invalid SSH port."
  }
  if ($Config.remoteRoot -isnot [string] -or $Config.remoteRoot -notmatch '^/[A-Za-z0-9._/-]+$' -or $Config.remoteRoot -match '(^|/)\.\.(/|$)') {
    throw "Service configuration contains an invalid remote root."
  }
}

function Get-RemoteControlSshArguments {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Config,
    [Parameter(Mandatory = $true)][ValidateSet("start", "status", "stop")][string]$Command
  )
  Assert-ServiceConfigValue -Config $Config
  $scriptNames = @{
    start = "start-all.sh"
    status = "status.sh"
    stop = "stop-all.sh"
  }
  $remoteCommand = "{0}/services/bin/{1}" -f ([string]$Config.remoteRoot).TrimEnd("/"), $scriptNames[$Command]
  return @(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "$($Config.sshUser)@$($Config.sshHost)",
    "-p", [string]$Config.sshPort,
    $remoteCommand
  )
}

function Invoke-RemoteWorkerCommand {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Config,
    [Parameter(Mandatory = $true)][ValidateSet("start", "status", "stop")][string]$Command,
    [string]$SshExecutable = "ssh.exe",
    [string[]]$SshPrefixArguments = @(),
    [string]$LogPath,
    [string[]]$SecretValues = @()
  )
  $sshArguments = @(Get-RemoteControlSshArguments -Config $Config -Command $Command)
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = @(& $SshExecutable @SshPrefixArguments @sshArguments 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if (-not [string]::IsNullOrEmpty($LogPath) -and $output.Count -gt 0) {
    Write-ServiceLog -Path $LogPath -Message ($output -join "`n") -SecretValues $SecretValues
  }
  if ($exitCode -ne 0) {
    throw "Remote worker command failed."
  }
  return $output
}

function ConvertTo-ProcessArgument {
  param([AllowEmptyString()][Parameter(Mandatory = $true)][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * (($backslashes * 2) + 1)))
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append(('\' * $backslashes))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) { [void]$builder.Append(('\' * ($backslashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Start-ManagedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][string]$CommandIdentity,
    [int]$ExistingProcessId = 0
  )
  if ($ExistingProcessId -gt 0 -and (Test-OwnedProcess -ProcessId $ExistingProcessId -ExpectedCommandFragment $CommandIdentity)) {
    return [pscustomobject]@{ processId = $ExistingProcessId; commandIdentity = $CommandIdentity; reused = $true }
  }
  if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw "Managed process working directory is unavailable." }
  foreach ($path in @($StdoutPath, $StderrPath)) {
    $directory = Split-Path -Parent $path
    if (-not [string]::IsNullOrEmpty($directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  }
  $argumentText = (@($Arguments | ForEach-Object { ConvertTo-ProcessArgument -Value ([string]$_) })) -join " "
  $process = Start-Process -FilePath $Executable `
    -ArgumentList $argumentText `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -PassThru
  return [pscustomobject]@{ processId = [int]$process.Id; commandIdentity = $CommandIdentity; reused = $false }
}

function Get-ManagedProcessTree {
  param([Parameter(Mandatory = $true)][int]$RootProcessId)
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
  $pending = [Collections.Generic.Queue[int]]::new()
  $pending.Enqueue($RootProcessId)
  $result = [Collections.Generic.List[int]]::new()
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    foreach ($child in $all | Where-Object { [int]$_.ParentProcessId -eq $parent }) {
      $childId = [int]$child.ProcessId
      $pending.Enqueue($childId)
      $result.Add($childId)
    }
  }
  $values = @($result)
  [array]::Reverse($values)
  return $values
}

function Stop-ManagedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$CommandIdentity,
    [int]$TimeoutSeconds = 10
  )
  if (-not (Test-OwnedProcess -ProcessId $ProcessId -ExpectedCommandFragment $CommandIdentity)) { return $false }
  $processIds = @((Get-ManagedProcessTree -RootProcessId $ProcessId)) + @($ProcessId)
  foreach ($ownedId in $processIds) { Stop-Process -Id $ownedId -ErrorAction SilentlyContinue }
  $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $TimeoutSeconds))
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 100
  }
  foreach ($ownedId in $processIds) { Stop-Process -Id $ownedId -Force -ErrorAction SilentlyContinue }
  return -not [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Test-TcpPort {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutMilliseconds = 1000
  )
  if ($Port -lt 1 -or $Port -gt 65535 -or $TimeoutMilliseconds -lt 1) { return $false }
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $result = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) { return $false }
    $client.EndConnect($result)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Invoke-HealthRequest {
  param([Parameter(Mandatory = $true)][string]$Uri, [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds)
  $parsed = $null
  if (-not [Uri]::TryCreate($Uri, [UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -ne "http" -or @("127.0.0.1", "localhost", "::1") -notcontains $parsed.Host) {
    throw "Health probe URI must use loopback HTTP."
  }
  $request = [Net.HttpWebRequest]::CreateHttp($parsed)
  $request.Method = "GET"
  $request.Timeout = $TimeoutMilliseconds
  $request.ReadWriteTimeout = $TimeoutMilliseconds
  $response = $request.GetResponse()
  try {
    $stream = $response.GetResponseStream()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    try {
      return [pscustomobject]@{ statusCode = [int]$response.StatusCode; body = $reader.ReadToEnd() }
    } finally {
      $reader.Dispose()
    }
  } finally {
    $response.Dispose()
  }
}

function Invoke-WebHealthProbe {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Uri, [int]$TimeoutMilliseconds = 1000)
  try {
    $response = Invoke-HealthRequest -Uri $Uri -TimeoutMilliseconds $TimeoutMilliseconds
    return $response.statusCode -ge 200 -and $response.statusCode -lt 400
  } catch {
    return $false
  }
}

function Invoke-JsonHealthProbe {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Uri, [int]$TimeoutMilliseconds = 1000)
  $response = Invoke-HealthRequest -Uri $Uri -TimeoutMilliseconds $TimeoutMilliseconds
  if ($response.statusCode -lt 200 -or $response.statusCode -ge 300) { throw "JSON health probe failed." }
  try { return $response.body | ConvertFrom-Json } catch { throw "JSON health response is invalid." }
}

function Wait-ServiceReady {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Probe,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [int]$PollMilliseconds = 250,
    [scriptblock]$StopRequested = { return $false }
  )
  $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $TimeoutSeconds))
  do {
    if (& $StopRequested) { return $false }
    if (& $Probe) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
    Start-Sleep -Milliseconds ([Math]::Max(1, $PollMilliseconds))
  } while ($true)
}

function Get-ServiceRecoveryAction {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][ValidateSet("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")][string]$ServiceName,
    [Parameter(Mandatory = $true)][ValidateSet("running", "stopped")][string]$DesiredState,
    [Parameter(Mandatory = $true)][bool]$ProcessAlive,
    [Parameter(Mandatory = $true)][bool]$Healthy,
    [Parameter(Mandatory = $true)][int]$FailureCount,
    [Parameter(Mandatory = $true)][bool]$InWarmup
  )
  if ($DesiredState -eq "stopped" -or $Healthy -or $InWarmup) { return "none" }
  if ($ServiceName -eq "tunnel") { return "reconnect-tunnel" }
  if ($ServiceName -eq "api" -or $ServiceName -eq "web") {
    return $(if (-not $ProcessAlive -or $FailureCount -ge 3) { "restart-local" } else { "none" })
  }
  if ($FailureCount -ge 3) { return "inspect-remote" }
  return "none"
}

function Set-ServiceProcessRecord {
  param([Parameter(Mandatory = $true)]$Record, [Parameter(Mandatory = $true)]$Process)
  $Record.processId = [int]$Process.processId
  $Record.commandIdentity = [string]$Process.commandIdentity
  $Record.state = "ready"
  $Record.failureCount = 0
  $Record.lastSuccessAt = [DateTime]::UtcNow.ToString("o")
  $Record.lastError = $null
  $Record.nextRetryAt = $null
}

function Set-ServiceStoppedRecord {
  param([Parameter(Mandatory = $true)]$Record)
  $Record.state = "stopped"
  $Record.processId = $null
  $Record.commandIdentity = $null
  $Record.failureCount = 0
  $Record.nextRetryAt = $null
}

function Invoke-ServiceOperation {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not $Operations.Contains($Name) -or $Operations[$Name] -isnot [scriptblock]) {
    throw "Service operation $Name is unavailable."
  }
  return & $Operations[$Name]
}

function Invoke-ServiceStartSequence {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations,
    [scriptblock]$PublishState = { param($current) }
  )
  Assert-RuntimeState -State $State
  if ($State.desiredState -ne "running") { return }

  $State.services.remoteOcr.state = "starting"
  $State.services.remoteEmbedding.state = "starting"
  & $PublishState $State
  if (-not (Invoke-ServiceOperation -Operations $Operations -Name "StartRemote")) { throw "Remote workers did not start." }
  foreach ($name in @("remoteOcr", "remoteEmbedding")) {
    $State.services.$name.state = "ready"
    $State.services.$name.failureCount = 0
    $State.services.$name.lastSuccessAt = [DateTime]::UtcNow.ToString("o")
  }
  & $PublishState $State
  if ($State.desiredState -ne "running") { return }

  $State.services.tunnel.state = "starting"
  & $PublishState $State
  $tunnel = Invoke-ServiceOperation -Operations $Operations -Name "StartTunnel"
  if (-not (Invoke-ServiceOperation -Operations $Operations -Name "WaitTunnel")) { throw "SSH tunnel did not become ready." }
  Set-ServiceProcessRecord -Record $State.services.tunnel -Process $tunnel
  & $PublishState $State
  if ($State.desiredState -ne "running") { return }

  $State.services.api.state = "starting"
  & $PublishState $State
  $api = Invoke-ServiceOperation -Operations $Operations -Name "StartApi"
  if (-not (Invoke-ServiceOperation -Operations $Operations -Name "WaitApi")) { throw "API did not become ready." }
  Set-ServiceProcessRecord -Record $State.services.api -Process $api
  & $PublishState $State
  if ($State.desiredState -ne "running") { return }

  $State.services.web.state = "starting"
  & $PublishState $State
  $web = Invoke-ServiceOperation -Operations $Operations -Name "StartWeb"
  if (-not (Invoke-ServiceOperation -Operations $Operations -Name "WaitWeb")) { throw "Web service did not become ready." }
  Set-ServiceProcessRecord -Record $State.services.web -Process $web
  & $PublishState $State
}

function Invoke-ServiceStopSequence {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations
  )
  foreach ($entry in @(
    @{ Name = "web"; Operation = "StopWeb" },
    @{ Name = "api"; Operation = "StopApi" },
    @{ Name = "tunnel"; Operation = "StopTunnel" }
  )) {
    try { Invoke-ServiceOperation -Operations $Operations -Name $entry.Operation | Out-Null } catch { $State.services.($entry.Name).lastError = $_.Exception.Message }
    Set-ServiceStoppedRecord -Record $State.services.($entry.Name)
  }
  try { Invoke-ServiceOperation -Operations $Operations -Name "StopRemote" | Out-Null } catch {
    $State.services.remoteOcr.lastError = $_.Exception.Message
    $State.services.remoteEmbedding.lastError = $_.Exception.Message
  }
  Set-ServiceStoppedRecord -Record $State.services.remoteOcr
  Set-ServiceStoppedRecord -Record $State.services.remoteEmbedding
}

function Test-ServiceOperation {
  param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations, [Parameter(Mandatory = $true)][string]$Name)
  try { return [bool](Invoke-ServiceOperation -Operations $Operations -Name $Name) } catch { return $false }
}

function Schedule-LocalServiceRestart {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][DateTime]$Now
  )
  $Record.restartCount = [long]$Record.restartCount + 1
  $Record.state = "retrying"
  $Record.nextRetryAt = $Now.AddSeconds((Get-RetryDelaySeconds -FailureCount $Record.restartCount)).ToString("o")
}

function Invoke-DueLocalServiceRestart {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations,
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][DateTime]$Now
  )
  if ($Record.state -ne "retrying" -or [string]::IsNullOrEmpty([string]$Record.nextRetryAt)) { return $false }
  $retryAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Record.nextRetryAt, [ref]$retryAt)) { throw "Service retry time is invalid." }
  if ([DateTimeOffset]$Now -lt $retryAt) { return $false }
  $process = Invoke-ServiceOperation -Operations $Operations -Name $Operation
  Set-ServiceProcessRecord -Record $Record -Process $process
  return $true
}

function Invoke-ServiceRecoveryCycle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations,
    [DateTime]$Now = [DateTime]::UtcNow
  )
  Assert-RuntimeState -State $State
  if ($State.desiredState -ne "running") { return }

  foreach ($service in @(
    @{ Name = "tunnel"; Alive = "IsTunnelAlive"; Probe = "ProbeTunnel"; Restart = "RestartTunnel" },
    @{ Name = "api"; Alive = "IsApiAlive"; Probe = "ProbeApi"; Restart = "RestartApi" },
    @{ Name = "web"; Alive = "IsWebAlive"; Probe = "ProbeWeb"; Restart = "RestartWeb" }
  )) {
    $record = $State.services.($service.Name)
    if ($record.state -eq "retrying") {
      if (Invoke-DueLocalServiceRestart -Record $record -Operations $Operations -Operation $service.Restart -Now $Now) { return }
      continue
    }
    $alive = Test-ServiceOperation -Operations $Operations -Name $service.Alive
    $healthy = $alive -and (Test-ServiceOperation -Operations $Operations -Name $service.Probe)
    if ($healthy) {
      $record.state = "ready"
      $record.failureCount = 0
      $record.lastSuccessAt = $Now.ToString("o")
      continue
    }
    $record.failureCount = [long]$record.failureCount + 1
    $action = Get-ServiceRecoveryAction -ServiceName $service.Name -DesiredState $State.desiredState -ProcessAlive $alive -Healthy $false -FailureCount $record.failureCount -InWarmup ($record.state -eq "starting")
    if ($action -eq "restart-local" -or $action -eq "reconnect-tunnel") {
      Schedule-LocalServiceRestart -Record $record -Now $Now
      return
    }
    $record.state = "degraded"
  }

  $remoteFailed = $false
  foreach ($service in @(
    @{ Name = "remoteOcr"; Probe = "ProbeRemoteOcr" },
    @{ Name = "remoteEmbedding"; Probe = "ProbeRemoteEmbedding" }
  )) {
    $record = $State.services.($service.Name)
    if (Test-ServiceOperation -Operations $Operations -Name $service.Probe) {
      $record.state = "ready"
      $record.failureCount = 0
      $record.lastSuccessAt = $Now.ToString("o")
      $record.nextRetryAt = $null
    } else {
      $inWarmup = $false
      if ($record.state -eq "starting" -and -not [string]::IsNullOrEmpty([string]$record.nextRetryAt)) {
        $warmupUntil = [DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse([string]$record.nextRetryAt, [ref]$warmupUntil)) {
          $inWarmup = [DateTimeOffset]$Now -lt $warmupUntil
        }
      }
      if ($inWarmup) { continue }
      if ($record.state -eq "starting") {
        $record.state = "degraded"
        $record.nextRetryAt = $null
      }
      $record.failureCount = [long]$record.failureCount + 1
      $record.state = "degraded"
      if ($record.failureCount -ge 3) { $remoteFailed = $true }
    }
  }
  if (-not $remoteFailed) { return }
  if (-not (Test-ServiceOperation -Operations $Operations -Name "InspectRemote")) {
    if (-not (Test-ServiceOperation -Operations $Operations -Name "RestartRemote")) { return }
    foreach ($name in @("remoteOcr", "remoteEmbedding")) {
      $record = $State.services.$name
      $record.restartCount = [long]$record.restartCount + 1
      $record.failureCount = 0
      $record.state = "starting"
      $record.nextRetryAt = $Now.AddSeconds(120).ToString("o")
    }
  }
}

function Enter-ServiceSupervisorLock {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)
  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrEmpty($directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.SetLength(0)
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 1024, $true)
    $writer.Write([string]$PID)
    $writer.Flush()
    $stream.Flush()
    return $stream
  } catch [IO.IOException] {
    return $null
  }
}

function Exit-ServiceSupervisorLock {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Lock, [Parameter(Mandatory = $true)][string]$Path)
  $Lock.Dispose()
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Write-DesiredServiceState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][ValidateSet("running", "stopped")][string]$DesiredState
  )
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  $path = Join-Path $RuntimeRoot "desired-state.json"
  $temporary = "$path.$([guid]::NewGuid().ToString('N')).tmp"
  $backup = "$path.$([guid]::NewGuid().ToString('N')).bak"
  try {
    [pscustomobject]@{ schemaVersion = 1; desiredState = $DesiredState } |
      ConvertTo-Json -Compress |
      Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temporary, $path, $backup) }
    else { [IO.File]::Move($temporary, $path) }
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  }
}

function Write-ServiceConfig {
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$SshHost,
    [Parameter(Mandatory = $true)][string]$SshUser,
    [Parameter(Mandatory = $true)][int]$SshPort,
    [Parameter(Mandatory = $true)][string]$RemoteRoot
  )
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  $path = Join-Path $RuntimeRoot "service-config.json"
  [pscustomobject]@{ sshHost = $SshHost; sshUser = $SshUser; sshPort = $SshPort; remoteRoot = $RemoteRoot } |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath $path -Encoding UTF8
  Read-ServiceConfig -Path $path | Out-Null
}

function Get-ServiceTaskDefinition {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot, [Parameter(Mandatory = $true)][string]$RuntimeRoot)
  $supervisorPath = Join-Path $ProjectRoot "scripts\service-supervisor.ps1"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorPath`" -RuntimeRoot `"$RuntimeRoot`""
  return [pscustomobject]@{
    name = "Appliot Services"
    executable = "powershell.exe"
    arguments = $arguments
    trigger = "CurrentUserLogon"
    multipleInstances = "IgnoreNew"
    executionTimeLimit = "PT0S"
  }
}

function Invoke-ControlOperation {
  param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations, [Parameter(Mandatory = $true)][string]$Name, [object[]]$Arguments = @())
  if (-not $Operations.Contains($Name) -or $Operations[$Name] -isnot [scriptblock]) { throw "Control operation $Name is unavailable." }
  return & $Operations[$Name] @Arguments
}

function Test-ManagedResourcesPresent {
  param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
  $statePath = Join-Path $RuntimeRoot "runtime-state.json"
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $false }
  try { $state = Read-RuntimeState -Path $statePath } catch { return $false }
  foreach ($name in $script:ServiceNames) {
    $record = $state.services.$name
    if ($record.state -ne "stopped" -or $null -ne $record.processId) { return $true }
  }
  return $false
}

function Invoke-ServiceControlCommand {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][ValidateSet("install", "start", "stop", "restart", "status", "logs", "uninstall")][string]$Command,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$SshHost,
    [string]$SshUser,
    [int]$SshPort = 22,
    [string]$RemoteRoot,
    [switch]$NoStart,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations
  )
  if ($Command -eq "status") { return @(Get-ServiceStatusLines -RuntimeRoot $RuntimeRoot) }
  if ($Command -eq "logs") { return @(Get-ServiceLogPaths -RuntimeRoot $RuntimeRoot) }

  if ($Command -eq "install") {
    if ([string]::IsNullOrWhiteSpace($SshHost) -or [string]::IsNullOrWhiteSpace($SshUser) -or [string]::IsNullOrWhiteSpace($RemoteRoot)) {
      throw "Install requires SSH host, user and remote root."
    }
    Invoke-ControlOperation -Operations $Operations -Name "ValidatePrerequisites" | Out-Null
    Write-ServiceConfig -RuntimeRoot $RuntimeRoot -SshHost $SshHost -SshUser $SshUser -SshPort $SshPort -RemoteRoot $RemoteRoot
    $config = Read-ServiceConfig -Path (Join-Path $RuntimeRoot "service-config.json")
    Invoke-ControlOperation -Operations $Operations -Name "ValidateSsh" -Arguments @($config) | Out-Null
    Invoke-ControlOperation -Operations $Operations -Name "Build" | Out-Null
    $task = Get-ServiceTaskDefinition -ProjectRoot $ProjectRoot -RuntimeRoot $RuntimeRoot
    $registered = Invoke-ControlOperation -Operations $Operations -Name "RegisterTask" -Arguments @($task)
    Write-DesiredServiceState -RuntimeRoot $RuntimeRoot -DesiredState "running"
    $processId = $null
    if (-not $NoStart) { $processId = Invoke-ControlOperation -Operations $Operations -Name "StartSupervisor" }
    return [pscustomobject]@{ task = $registered; processId = $processId }
  }

  if ($Command -eq "start") {
    Write-DesiredServiceState -RuntimeRoot $RuntimeRoot -DesiredState "running"
    if (-not (Invoke-ControlOperation -Operations $Operations -Name "IsSupervisorRunning")) {
      return Invoke-ControlOperation -Operations $Operations -Name "StartSupervisor"
    }
    return $null
  }

  if ($Command -eq "stop") {
    Write-DesiredServiceState -RuntimeRoot $RuntimeRoot -DesiredState "stopped"
    if (Invoke-ControlOperation -Operations $Operations -Name "IsSupervisorRunning") {
      Invoke-ControlOperation -Operations $Operations -Name "StopSupervisor" | Out-Null
    } elseif (Test-ManagedResourcesPresent -RuntimeRoot $RuntimeRoot) {
      Invoke-ControlOperation -Operations $Operations -Name "StartSupervisor" | Out-Null
      Invoke-ControlOperation -Operations $Operations -Name "StopSupervisor" | Out-Null
    }
    return $null
  }

  if ($Command -eq "restart") {
    Write-DesiredServiceState -RuntimeRoot $RuntimeRoot -DesiredState "stopped"
    if (Invoke-ControlOperation -Operations $Operations -Name "IsSupervisorRunning") {
      Invoke-ControlOperation -Operations $Operations -Name "StopSupervisor" | Out-Null
    }
    Write-DesiredServiceState -RuntimeRoot $RuntimeRoot -DesiredState "running"
    return Invoke-ControlOperation -Operations $Operations -Name "StartSupervisor"
  }

  Write-DesiredServiceState -RuntimeRoot $RuntimeRoot -DesiredState "stopped"
  if (Invoke-ControlOperation -Operations $Operations -Name "IsSupervisorRunning") {
    Invoke-ControlOperation -Operations $Operations -Name "StopSupervisor" | Out-Null
  } elseif (Test-ManagedResourcesPresent -RuntimeRoot $RuntimeRoot) {
    Invoke-ControlOperation -Operations $Operations -Name "StartSupervisor" | Out-Null
    Invoke-ControlOperation -Operations $Operations -Name "StopSupervisor" | Out-Null
  }
  if (Invoke-ControlOperation -Operations $Operations -Name "TaskExists") {
    Invoke-ControlOperation -Operations $Operations -Name "RemoveTask" | Out-Null
  }
  return $null
}

function Get-ServiceStatusText {
  param([Parameter(Mandatory = $true)][string]$State)
  $values = @{
    stopped = '"\u672a\u8fd0\u884c"' | ConvertFrom-Json
    starting = '"\u542f\u52a8\u4e2d"' | ConvertFrom-Json
    ready = '"\u5c31\u7eea"' | ConvertFrom-Json
    degraded = '"\u5f02\u5e38"' | ConvertFrom-Json
    retrying = '"\u91cd\u8bd5\u4e2d"' | ConvertFrom-Json
    failed = '"\u5931\u8d25"' | ConvertFrom-Json
  }
  if ($values.ContainsKey($State)) { return $values[$State] }
  return $values.failed
}

function Get-ServiceStatusLines {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$RuntimeRoot, [string]$SupervisorIdentity = "service-supervisor.ps1")
  $labels = [ordered]@{
    supervisor = '"Appliot \u5b88\u62a4\u5668"' | ConvertFrom-Json
    remoteOcr = '"\u8fdc\u7a0b OCR"' | ConvertFrom-Json
    remoteEmbedding = '"\u8fdc\u7a0b Embedding"' | ConvertFrom-Json
    tunnel = '"SSH \u96a7\u9053"' | ConvertFrom-Json
    api = '"API / \u6d4f\u89c8\u5668 Worker"' | ConvertFrom-Json
    web = '"\u524d\u7aef"' | ConvertFrom-Json
  }
  $statePath = Join-Path $RuntimeRoot "runtime-state.json"
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    return @($labels.Values | ForEach-Object { "{0,-24} {1}" -f $_, (Get-ServiceStatusText -State "stopped") })
  }
  try { $state = Read-RuntimeState -Path $statePath } catch {
    return @($labels.Values | ForEach-Object { "{0,-24} {1}" -f $_, (Get-ServiceStatusText -State "failed") })
  }
  $supervisorState = if ($state.supervisorPid -gt 0 -and (Test-OwnedProcess -ProcessId $state.supervisorPid -ExpectedCommandFragment $SupervisorIdentity)) { "ready" } else { "stopped" }
  $lines = [Collections.Generic.List[string]]::new()
  $lines.Add(("{0,-24} {1}" -f $labels.supervisor, (Get-ServiceStatusText -State $supervisorState)))
  foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) {
    $record = $state.services.$name
    $suffix = if (-not [string]::IsNullOrEmpty([string]$record.lastError) -and $record.state -ne "ready") { " - $($record.lastError)" } else { "" }
    $lines.Add(("{0,-24} {1}{2}" -f $labels[$name], (Get-ServiceStatusText -State $record.state), $suffix))
  }
  return @($lines)
}

function Get-ServiceLogPaths {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$RuntimeRoot)
  $logRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot "logs"))
  if (-not (Test-Path -LiteralPath $logRoot -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $logRoot -File -Filter "*.log*" | ForEach-Object {
    $path = [IO.Path]::GetFullPath($_.FullName)
    if ($path.StartsWith($logRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $path }
  } | Sort-Object)
}

Export-ModuleMember -Function `
  Read-ServiceConfig, `
  Get-RetryDelaySeconds, `
  Protect-LogText, `
  Write-ServiceLog, `
  New-ServiceRuntimeState, `
  Read-RuntimeState, `
  Write-RuntimeState, `
  Test-OwnedProcess, `
  Get-RemoteControlSshArguments, `
  Invoke-RemoteWorkerCommand, `
  Start-ManagedProcess, `
  Stop-ManagedProcess, `
  Test-TcpPort, `
  Invoke-WebHealthProbe, `
  Invoke-JsonHealthProbe, `
  Wait-ServiceReady, `
  Get-ServiceRecoveryAction, `
  Invoke-ServiceStartSequence, `
  Invoke-ServiceStopSequence, `
  Invoke-ServiceRecoveryCycle, `
  Enter-ServiceSupervisorLock, `
  Exit-ServiceSupervisorLock, `
  Write-DesiredServiceState, `
  Get-ServiceTaskDefinition, `
  Invoke-ServiceControlCommand, `
  Get-ServiceStatusLines, `
  Get-ServiceLogPaths
