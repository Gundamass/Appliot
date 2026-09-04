Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "service-supervisor.psm1") -Force

$script:failures = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Message)
  if ($Expected -ne $Actual) { throw "$Message Expected '$Expected', received '$Actual'." }
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

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "appliot-service-control-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
  Invoke-Case "installs in validated order without storing secrets in task arguments" {
    $events = [Collections.Generic.List[string]]::new()
    $operations = @{
      ValidatePrerequisites = { $events.Add("validate-prerequisites") }
      ValidateSsh = { param($config) $events.Add("validate-ssh:$($config.sshHost)") }
      Build = { $events.Add("build") }
      RegisterTask = { param($task) $events.Add("register-task"); return $task }
      StartSupervisor = { $events.Add("start-supervisor"); return 1234 }
      IsSupervisorRunning = { return $false }
      StopSupervisor = { $events.Add("stop-supervisor") }
      RemoveTask = { $events.Add("remove-task") }
      TaskExists = { return $false }
    }
    $result = Invoke-ServiceControlCommand -Command "install" -RuntimeRoot $testRoot -ProjectRoot $testRoot -SshHost "models.example.com" -SshUser "resume_user" -SshPort 2222 -RemoteRoot "/home/resume_user/resume-ai" -Operations $operations
    Assert-Equal "validate-prerequisites,validate-ssh:models.example.com,build,register-task,start-supervisor" ($events -join ",") "Install order was incorrect."
    Assert-True (Test-Path -LiteralPath (Join-Path $testRoot "service-config.json")) "Install did not write local service configuration."
    Assert-Equal "Appliot Services" $result.task.name "Install did not use the fixed task name."
    Assert-Equal "IgnoreNew" $result.task.multipleInstances "Install did not prevent duplicate task instances."
    Assert-True $result.task.arguments.Contains("service-supervisor.ps1") "Task action did not invoke the supervisor."
    foreach ($privateValue in @("models.example.com", "resume_user", "/home/resume_user/resume-ai")) {
      Assert-True (-not $result.task.arguments.Contains($privateValue)) "Task arguments exposed local service configuration."
    }
  }

  Invoke-Case "keeps start and stop idempotent" {
    $events = [Collections.Generic.List[string]]::new()
    $runtime = [pscustomobject]@{ running = $true }
    $operations = @{
      IsSupervisorRunning = { return $runtime.running }
      StartSupervisor = { $events.Add("start"); $runtime.running = $true; return 44 }
      StopSupervisor = { $events.Add("stop"); $runtime.running = $false }
    }
    Invoke-ServiceControlCommand -Command "start" -RuntimeRoot $testRoot -ProjectRoot $testRoot -Operations $operations | Out-Null
    Assert-Equal "" ($events -join ",") "Start duplicated an existing supervisor."
    $runtime.running = $false
    Invoke-ServiceControlCommand -Command "start" -RuntimeRoot $testRoot -ProjectRoot $testRoot -Operations $operations | Out-Null
    Invoke-ServiceControlCommand -Command "start" -RuntimeRoot $testRoot -ProjectRoot $testRoot -Operations $operations | Out-Null
    Assert-Equal "start" ($events -join ",") "Start was not idempotent."
    Invoke-ServiceControlCommand -Command "stop" -RuntimeRoot $testRoot -ProjectRoot $testRoot -Operations $operations | Out-Null
    Invoke-ServiceControlCommand -Command "stop" -RuntimeRoot $testRoot -ProjectRoot $testRoot -Operations $operations | Out-Null
    Assert-Equal "start,stop" ($events -join ",") "Stop was not idempotent."
    $desired = Get-Content -LiteralPath (Join-Path $testRoot "desired-state.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-Equal "stopped" $desired.desiredState "Stop did not persist the stopped desired state."
  }

  Invoke-Case "starts one cleanup supervisor when stopped state still has managed resources" {
    $runtime = Join-Path $testRoot "orphan-runtime"
    New-Item -ItemType Directory -Path $runtime | Out-Null
    $state = New-ServiceRuntimeState -DesiredState "running"
    $state.services.remoteOcr.state = "ready"
    Write-RuntimeState -Path (Join-Path $runtime "runtime-state.json") -State $state
    $events = [Collections.Generic.List[string]]::new()
    $operations = @{
      IsSupervisorRunning = { return $false }
      StartSupervisor = { $events.Add("cleanup-start"); return 55 }
      StopSupervisor = { $events.Add("wait-stop") }
    }
    Invoke-ServiceControlCommand -Command "stop" -RuntimeRoot $runtime -ProjectRoot $testRoot -Operations $operations | Out-Null
    Assert-Equal "cleanup-start,wait-stop" ($events -join ",") "Stop did not clean orphaned managed resources."
  }

  Invoke-Case "formats concise Chinese status for stopped, degraded and ready states" {
    $supervisorLabel = '"Appliot \u5b88\u62a4\u5668"' | ConvertFrom-Json
    $notRunningLabel = '"\u672a\u8fd0\u884c"' | ConvertFrom-Json
    $remoteOcrLabel = '"\u8fdc\u7a0b OCR"' | ConvertFrom-Json
    $abnormalLabel = '"\u5f02\u5e38"' | ConvertFrom-Json
    $apiLabel = '"API / \u6d4f\u89c8\u5668 Worker"' | ConvertFrom-Json
    $stopped = @(Get-ServiceStatusLines -RuntimeRoot (Join-Path $testRoot "missing"))
    Assert-True (($stopped -join "`n").Contains($supervisorLabel)) "Stopped status omitted the supervisor."
    Assert-True (($stopped -join "`n").Contains($notRunningLabel)) "Stopped status was not clear."

    $runtime = Join-Path $testRoot "status-runtime"
    New-Item -ItemType Directory -Path $runtime | Out-Null
    $state = New-ServiceRuntimeState -DesiredState "running"
    $state.supervisorPid = $PID
    foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) { $state.services.$name.state = "ready" }
    $state.services.remoteOcr.state = "degraded"
    $state.services.remoteOcr.lastError = "worker offline"
    Write-RuntimeState -Path (Join-Path $runtime "runtime-state.json") -State $state
    $lines = @(Get-ServiceStatusLines -RuntimeRoot $runtime -SupervisorIdentity "powershell")
    Assert-True (($lines -join "`n").Contains($remoteOcrLabel)) "Status omitted remote OCR."
    Assert-True (($lines -join "`n").Contains($abnormalLabel)) "Degraded service was not visible."
    Assert-True (($lines -join "`n").Contains($apiLabel)) "Status omitted API/browser worker."
    Assert-Equal 6 $lines.Count "Status did not produce exactly six service lines."
  }

  Invoke-Case "treats cached ready services as stopped when the supervisor is absent" {
    $runtime = Join-Path $testRoot "stale-ready-runtime"
    New-Item -ItemType Directory -Path $runtime | Out-Null
    $state = New-ServiceRuntimeState -DesiredState "running"
    $state.supervisorPid = 0
    foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) {
      $state.services.$name.state = "ready"
    }
    Write-RuntimeState -Path (Join-Path $runtime "runtime-state.json") -State $state

    $notRunningLabel = '"\u672a\u8fd0\u884c"' | ConvertFrom-Json
    $readyLabel = '"\u5c31\u7eea"' | ConvertFrom-Json
    $lines = @(Get-ServiceStatusLines -RuntimeRoot $runtime)

    Assert-Equal 6 $lines.Count "Status did not produce exactly six service lines."
    Assert-Equal 6 (@($lines | Where-Object { $_.Contains($notRunningLabel) }).Count) "Stopped supervisor did not invalidate every cached child status."
    Assert-True (-not (($lines -join "`n").Contains($readyLabel))) "Stopped supervisor exposed a stale ready status."
  }

  Invoke-Case "lists only managed log files and uninstalls without deleting runtime data" {
    $logRoot = Join-Path $testRoot "logs"
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $logRoot "api.stdout.log") -Value "ok"
    Set-Content -LiteralPath (Join-Path $testRoot "private.txt") -Value "private"
    $logs = @(Get-ServiceLogPaths -RuntimeRoot $testRoot)
    Assert-Equal 1 $logs.Count "Logs command returned unmanaged files."
    Assert-True $logs[0].StartsWith($logRoot, [StringComparison]::OrdinalIgnoreCase) "Logs command escaped the managed log directory."

    $events = [Collections.Generic.List[string]]::new()
    $operations = @{
      IsSupervisorRunning = { return $false }
      StopSupervisor = { $events.Add("stop") }
      RemoveTask = { $events.Add("remove-task") }
      TaskExists = { return $true }
    }
    Invoke-ServiceControlCommand -Command "uninstall" -RuntimeRoot $testRoot -ProjectRoot $testRoot -Operations $operations | Out-Null
    Assert-Equal "remove-task" ($events -join ",") "Uninstall did not remove the task exactly once."
    Assert-True (Test-Path -LiteralPath (Join-Path $testRoot "private.txt")) "Uninstall deleted runtime data."
  }

  Invoke-Case "control entry exposes all commands without expression evaluation" {
    $scriptText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "service-control.ps1") -Raw -Encoding UTF8
    foreach ($command in @("install", "start", "stop", "restart", "status", "logs", "uninstall")) {
      Assert-True $scriptText.Contains($command) "Control entry omitted command $command."
    }
    Assert-True (-not $scriptText.Contains("Invoke-Expression")) "Control entry uses expression evaluation."
  }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) { throw "$script:failures service control PowerShell test case(s) failed." }
Write-Output "All service control PowerShell tests passed."
