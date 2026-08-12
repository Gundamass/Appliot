[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [string]$ConfigPath,
  [ValidateRange(1, 300)][int]$LoopIntervalSeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrEmpty($RuntimeRoot)) { $RuntimeRoot = Join-Path $projectRoot ".runtime\services" }
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
if ([string]::IsNullOrEmpty($ConfigPath)) { $ConfigPath = Join-Path $RuntimeRoot "service-config.json" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

Import-Module (Join-Path $PSScriptRoot "local-launch.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "service-supervisor.psm1") -Force

$statePath = Join-Path $RuntimeRoot "runtime-state.json"
$desiredStatePath = Join-Path $RuntimeRoot "desired-state.json"
$lockPath = Join-Path $RuntimeRoot "supervisor.lock"
$logRoot = Join-Path $RuntimeRoot "logs"
$supervisorLog = Join-Path $logRoot "supervisor.log"
$remoteLog = Join-Path $logRoot "remote.log"
$tunnelStdout = Join-Path $logRoot "tunnel.stdout.log"
$tunnelStderr = Join-Path $logRoot "tunnel.stderr.log"
$apiStdout = Join-Path $logRoot "api.stdout.log"
$apiStderr = Join-Path $logRoot "api.stderr.log"
$webStdout = Join-Path $logRoot "web.stdout.log"
$webStderr = Join-Path $logRoot "web.stderr.log"

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Read-DesiredStateValue {
  if (-not (Test-Path -LiteralPath $desiredStatePath -PathType Leaf)) { return "running" }
  try {
    $value = Get-Content -LiteralPath $desiredStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $properties = @($value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    if (($properties -join ",") -ne "desiredState,schemaVersion" -or [int]$value.schemaVersion -ne 1 -or @("running", "stopped") -notcontains [string]$value.desiredState) {
      throw "invalid"
    }
    return [string]$value.desiredState
  } catch {
    throw "Desired service state is invalid."
  }
}

function Get-ExistingProcessId {
  param($Record)
  if ($null -eq $Record.processId) { return 0 }
  return [int]$Record.processId
}

function Stop-RecordedProcess {
  param([Parameter(Mandatory = $true)]$Record, [Parameter(Mandatory = $true)][string]$CommandIdentity, [Parameter(Mandatory = $true)][int]$TimeoutSeconds)
  $processId = Get-ExistingProcessId $Record
  if ($processId -lt 1) { return $true }
  return Stop-ManagedProcess -ProcessId $processId -CommandIdentity $CommandIdentity -TimeoutSeconds $TimeoutSeconds
}

function Get-AdapterReady {
  param([Parameter(Mandatory = $true)][string]$AdapterId)
  try {
    $statuses = @(Invoke-JsonHealthProbe -Uri "http://127.0.0.1:43120/api/health/adapters" -TimeoutMilliseconds 2000)
    $match = @($statuses | Where-Object { $_.id -eq $AdapterId })
    return $match.Count -eq 1 -and $match[0].state -eq "ready"
  } catch {
    return $false
  }
}

function Get-LogSecrets {
  $effective = Get-EffectiveEnvironment -EnvFile (Join-Path $projectRoot ".env.local") -ProcessEnvironment ([Environment]::GetEnvironmentVariables())
  $values = [Collections.Generic.List[string]]::new()
  foreach ($name in @($effective.Keys)) {
    if ([string]$name -match '(?i)(TOKEN|API_KEY|SECRET|PASSWORD)$') {
      $value = [string]$effective[$name]
      if (-not [string]::IsNullOrEmpty($value)) { $values.Add($value) }
    }
  }
  return @($values)
}

$lock = Enter-ServiceSupervisorLock -Path $lockPath
if ($null -eq $lock) { exit 0 }

$logSecrets = @()
try {
  $config = Read-ServiceConfig -Path $ConfigPath
  $logSecrets = @(Get-LogSecrets)
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Read-RuntimeState -Path $statePath
  } else {
    $state = New-ServiceRuntimeState -DesiredState "running"
  }
  $state.supervisorPid = $PID
  $state.desiredState = Read-DesiredStateValue

  $nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
  $sshExecutable = (Get-Command ssh.exe -ErrorAction Stop).Source
  $apiWorkingDirectory = Join-Path $projectRoot "apps\api"

  $operations = @{
    StartRemote = {
      Invoke-RemoteWorkerCommand -Config $config -Command "start" -SshExecutable $sshExecutable -LogPath $remoteLog -SecretValues $logSecrets | Out-Null
      return $true
    }
    StartTunnel = {
      $arguments = @(Get-ModelTunnelSshArguments -HostName $config.sshHost -User $config.sshUser -Port $config.sshPort)
      return Start-ManagedProcess -Executable $sshExecutable -Arguments $arguments -WorkingDirectory $projectRoot -StdoutPath $tunnelStdout -StderrPath $tunnelStderr -CommandIdentity "18080:127.0.0.1:18080" -ExistingProcessId (Get-ExistingProcessId $state.services.tunnel)
    }
    WaitTunnel = {
      return Wait-ServiceReady -Probe {
        (Test-TcpPort -HostName "127.0.0.1" -Port 18080 -TimeoutMilliseconds 500) -and
        (Test-TcpPort -HostName "127.0.0.1" -Port 43121 -TimeoutMilliseconds 500)
      } -TimeoutSeconds 30 -PollMilliseconds 500 -StopRequested { (Read-DesiredStateValue) -eq "stopped" }
    }
    StartApi = {
      return Start-ManagedProcess -Executable $nodeExecutable -Arguments @("--env-file-if-exists=../../.env.local", "dist/server.js") -WorkingDirectory $apiWorkingDirectory -StdoutPath $apiStdout -StderrPath $apiStderr -CommandIdentity "dist/server.js" -ExistingProcessId (Get-ExistingProcessId $state.services.api)
    }
    WaitApi = {
      return Wait-ServiceReady -Probe { Invoke-WebHealthProbe -Uri "http://127.0.0.1:43120/api/health/adapters" -TimeoutMilliseconds 2000 } -TimeoutSeconds 60 -PollMilliseconds 500 -StopRequested { (Read-DesiredStateValue) -eq "stopped" }
    }
    StartWeb = {
      return Start-ManagedProcess -Executable $nodeExecutable -Arguments @("scripts/serve-web.mjs") -WorkingDirectory $projectRoot -StdoutPath $webStdout -StderrPath $webStderr -CommandIdentity "scripts/serve-web.mjs" -ExistingProcessId (Get-ExistingProcessId $state.services.web)
    }
    WaitWeb = {
      return Wait-ServiceReady -Probe { Invoke-WebHealthProbe -Uri "http://127.0.0.1:5173/" -TimeoutMilliseconds 2000 } -TimeoutSeconds 30 -PollMilliseconds 500 -StopRequested { (Read-DesiredStateValue) -eq "stopped" }
    }
    StopWeb = { return Stop-RecordedProcess -Record $state.services.web -CommandIdentity "scripts/serve-web.mjs" -TimeoutSeconds 10 }
    StopApi = { return Stop-RecordedProcess -Record $state.services.api -CommandIdentity "dist/server.js" -TimeoutSeconds 15 }
    StopTunnel = { return Stop-RecordedProcess -Record $state.services.tunnel -CommandIdentity "18080:127.0.0.1:18080" -TimeoutSeconds 10 }
    StopRemote = {
      Invoke-RemoteWorkerCommand -Config $config -Command "stop" -SshExecutable $sshExecutable -LogPath $remoteLog -SecretValues $logSecrets | Out-Null
      return $true
    }
    IsTunnelAlive = { return (Get-ExistingProcessId $state.services.tunnel) -gt 0 -and (Test-OwnedProcess -ProcessId (Get-ExistingProcessId $state.services.tunnel) -ExpectedCommandFragment "18080:127.0.0.1:18080") }
    ProbeTunnel = { return (Test-TcpPort -HostName "127.0.0.1" -Port 18080 -TimeoutMilliseconds 500) -and (Test-TcpPort -HostName "127.0.0.1" -Port 43121 -TimeoutMilliseconds 500) }
    RestartTunnel = {
      Stop-RecordedProcess -Record $state.services.tunnel -CommandIdentity "18080:127.0.0.1:18080" -TimeoutSeconds 5 | Out-Null
      return & $operations.StartTunnel
    }
    IsApiAlive = { return (Get-ExistingProcessId $state.services.api) -gt 0 -and (Test-OwnedProcess -ProcessId (Get-ExistingProcessId $state.services.api) -ExpectedCommandFragment "dist/server.js") }
    ProbeApi = { return Invoke-WebHealthProbe -Uri "http://127.0.0.1:43120/api/health/adapters" -TimeoutMilliseconds 2000 }
    RestartApi = {
      Stop-RecordedProcess -Record $state.services.api -CommandIdentity "dist/server.js" -TimeoutSeconds 10 | Out-Null
      return & $operations.StartApi
    }
    IsWebAlive = { return (Get-ExistingProcessId $state.services.web) -gt 0 -and (Test-OwnedProcess -ProcessId (Get-ExistingProcessId $state.services.web) -ExpectedCommandFragment "scripts/serve-web.mjs") }
    ProbeWeb = { return Invoke-WebHealthProbe -Uri "http://127.0.0.1:5173/" -TimeoutMilliseconds 2000 }
    RestartWeb = {
      Stop-RecordedProcess -Record $state.services.web -CommandIdentity "scripts/serve-web.mjs" -TimeoutSeconds 5 | Out-Null
      return & $operations.StartWeb
    }
    ProbeRemoteOcr = { return Get-AdapterReady -AdapterId "ocr" }
    ProbeRemoteEmbedding = { return Get-AdapterReady -AdapterId "embedding" }
    InspectRemote = {
      try {
        Invoke-RemoteWorkerCommand -Config $config -Command "status" -SshExecutable $sshExecutable -LogPath $remoteLog -SecretValues $logSecrets | Out-Null
        return $true
      } catch { return $false }
    }
    RestartRemote = {
      try {
        Invoke-RemoteWorkerCommand -Config $config -Command "start" -SshExecutable $sshExecutable -LogPath $remoteLog -SecretValues $logSecrets | Out-Null
        return $true
      } catch { return $false }
    }
  }

  Write-ServiceLog -Path $supervisorLog -Message "Service supervisor started."
  while ($true) {
    $state.desiredState = Read-DesiredStateValue
    $state.supervisorPid = $PID
    if ($state.desiredState -eq "stopped") {
      Invoke-ServiceStopSequence -State $state -Operations $operations
      Write-RuntimeState -Path $statePath -State $state
      Write-ServiceLog -Path $supervisorLog -Message "Service supervisor completed the stop sequence."
      break
    }

    $localReady = $state.services.tunnel.state -eq "ready" -and $state.services.api.state -eq "ready" -and $state.services.web.state -eq "ready"
    if (-not $localReady) {
      try {
        Invoke-ServiceStartSequence -State $state -Operations $operations -PublishState {
          param($current)
          Write-RuntimeState -Path $statePath -State $current
        }
      } catch {
        Write-ServiceLog -Path $supervisorLog -Message ("Startup sequence failed: " + $_.Exception.Message) -SecretValues $logSecrets
      }
    } else {
      try {
        Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now ([DateTime]::UtcNow)
      } catch {
        Write-ServiceLog -Path $supervisorLog -Message ("Recovery cycle failed: " + $_.Exception.Message) -SecretValues $logSecrets
      }
    }
    Write-RuntimeState -Path $statePath -State $state
    Start-Sleep -Seconds $LoopIntervalSeconds
  }
} catch {
  Write-ServiceLog -Path $supervisorLog -Message ("Supervisor stopped unexpectedly: " + $_.Exception.Message) -SecretValues $logSecrets
  throw
} finally {
  if (Get-Variable state -ErrorAction SilentlyContinue) {
    $state.supervisorPid = 0
    try { Write-RuntimeState -Path $statePath -State $state } catch { }
  }
  Exit-ServiceSupervisorLock -Lock $lock -Path $lockPath
}
