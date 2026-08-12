[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet("install", "start", "stop", "restart", "status", "logs", "uninstall")][string]$Command = "status",
  [string]$SshHost,
  [string]$SshUser,
  [ValidateRange(1, 65535)][int]$SshPort = 22,
  [string]$RemoteRoot,
  [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeRoot = Join-Path $projectRoot ".runtime\services"
$statePath = Join-Path $runtimeRoot "runtime-state.json"
$taskName = "Appliot Services"
$supervisorPath = Join-Path $PSScriptRoot "service-supervisor.ps1"

Import-Module (Join-Path $PSScriptRoot "service-supervisor.psm1") -Force

function Get-SupervisorProcessId {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return 0 }
  try {
    $state = Read-RuntimeState -Path $statePath
    if ($state.supervisorPid -gt 0 -and (Test-OwnedProcess -ProcessId $state.supervisorPid -ExpectedCommandFragment "service-supervisor.ps1")) {
      return [int]$state.supervisorPid
    }
  } catch { }
  return 0
}

function Start-SupervisorProcess {
  $existing = Get-SupervisorProcessId
  if ($existing -gt 0) { return $existing }
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorPath`" -RuntimeRoot `"$runtimeRoot`"" `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru
  return [int]$process.Id
}

function Stop-SupervisorProcess {
  $processId = Get-SupervisorProcessId
  if ($processId -lt 1) { return }
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-OwnedProcess -ProcessId $processId -ExpectedCommandFragment "service-supervisor.ps1")) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "Service supervisor did not complete the stop sequence before timeout."
}

function Assert-LocalPrerequisites {
  foreach ($name in @("node.exe", "corepack.cmd", "ssh.exe", "powershell.exe")) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "Required executable is unavailable: $name" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot ".env.local") -PathType Leaf)) { throw ".env.local is required before installing services." }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules") -PathType Container)) { throw "Project dependencies are not installed." }
}

function Assert-RemoteConnection {
  param($Config)
  $arguments = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "$($Config.sshUser)@$($Config.sshHost)", "-p", [string]$Config.sshPort, "$($Config.remoteRoot)/services/bin/status.sh")
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & ssh.exe @arguments 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($exitCode -ne 0) {
    $probeArguments = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "$($Config.sshUser)@$($Config.sshHost)", "-p", [string]$Config.sshPort, "test -x $($Config.remoteRoot)/services/bin/start-all.sh -a -x $($Config.remoteRoot)/services/bin/stop-all.sh")
    try {
      $ErrorActionPreference = "Continue"
      & ssh.exe @probeArguments 2>&1 | Out-Null
      $probeExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previous
    }
    if ($probeExitCode -ne 0) { throw "Remote worker control is unavailable over non-interactive SSH." }
  }
}

function Build-ProductionArtifacts {
  Push-Location $projectRoot
  try {
    & corepack pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Production build failed." }
  } finally {
    Pop-Location
  }
}

function Register-LoginTask {
  param($Definition)
  $action = New-ScheduledTaskAction -Execute $Definition.executable -Argument $Definition.arguments -WorkingDirectory $projectRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable
  Register-ScheduledTask -TaskName $Definition.name -Action $action -Trigger $trigger -Settings $settings -Description "Starts the Appliot local application and remote AI workers after user logon." -Force | Out-Null
  return $Definition
}

function Test-LoginTask {
  return $null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
}

function Remove-LoginTask {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

$operations = @{
  ValidatePrerequisites = { Assert-LocalPrerequisites }
  ValidateSsh = { param($config) Assert-RemoteConnection -Config $config }
  Build = { Build-ProductionArtifacts }
  RegisterTask = { param($task) return Register-LoginTask -Definition $task }
  StartSupervisor = { return Start-SupervisorProcess }
  IsSupervisorRunning = { return (Get-SupervisorProcessId) -gt 0 }
  StopSupervisor = { Stop-SupervisorProcess }
  RemoveTask = { Remove-LoginTask }
  TaskExists = { return Test-LoginTask }
}

$parameters = @{
  Command = $Command
  RuntimeRoot = $runtimeRoot
  ProjectRoot = $projectRoot
  SshPort = $SshPort
  NoStart = $NoStart
  Operations = $operations
}
if (-not [string]::IsNullOrWhiteSpace($SshHost)) { $parameters.SshHost = $SshHost }
if (-not [string]::IsNullOrWhiteSpace($SshUser)) { $parameters.SshUser = $SshUser }
if (-not [string]::IsNullOrWhiteSpace($RemoteRoot)) { $parameters.RemoteRoot = $RemoteRoot }

$result = Invoke-ServiceControlCommand @parameters
if ($Command -eq "status" -or $Command -eq "logs") {
  $result | Write-Output
} elseif ($Command -eq "install") {
  Write-Output "Appliot services installed."
} elseif ($Command -eq "uninstall") {
  Write-Output "Appliot services uninstalled; runtime data was preserved."
} else {
  Write-Output "Appliot service command completed: $Command"
}
