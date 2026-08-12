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

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "appliot-service-supervisor-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
  Invoke-Case "strictly reads a valid service configuration" {
    $path = Join-Path $testRoot "valid-config.json"
    Set-Content -LiteralPath $path -Encoding UTF8 -Value '{"sshHost":"models.example.com","sshUser":"resume_user","sshPort":2222,"remoteRoot":"/home/resume_user/resume-ai"}'
    $config = Read-ServiceConfig -Path $path
    Assert-Equal "models.example.com" $config.sshHost "SSH host was not preserved."
    Assert-Equal "resume_user" $config.sshUser "SSH user was not preserved."
    Assert-Equal 2222 $config.sshPort "SSH port was not parsed as an integer."
    Assert-Equal "/home/resume_user/resume-ai" $config.remoteRoot "Remote root was not preserved."
  }

  Invoke-Case "rejects malformed and unsafe service configurations" {
    $invalidValues = @(
      '{}',
      '{"sshHost":"models.example.com","sshUser":"resume_user","sshPort":22,"remoteRoot":"/home/resume_user/resume-ai","extra":true}',
      '{"sshHost":"-oProxyCommand=bad","sshUser":"resume_user","sshPort":22,"remoteRoot":"/home/resume_user/resume-ai"}',
      '{"sshHost":"models.example.com","sshUser":"bad user","sshPort":22,"remoteRoot":"/home/resume_user/resume-ai"}',
      '{"sshHost":"models.example.com","sshUser":"resume_user","sshPort":0,"remoteRoot":"/home/resume_user/resume-ai"}',
      '{"sshHost":"models.example.com","sshUser":"resume_user","sshPort":22,"remoteRoot":"relative/path"}'
    )
    for ($index = 0; $index -lt $invalidValues.Count; $index++) {
      $path = Join-Path $testRoot "invalid-config-$index.json"
      Set-Content -LiteralPath $path -Encoding UTF8 -Value $invalidValues[$index]
      Assert-Rejected { Read-ServiceConfig -Path $path } "Invalid service configuration $index was accepted."
    }
  }

  Invoke-Case "uses the bounded retry delay sequence" {
    $actual = 1..6 | ForEach-Object { Get-RetryDelaySeconds -FailureCount $_ }
    Assert-Equal "2,5,10,30,60,60" ($actual -join ",") "Retry delays did not match the required sequence."
    Assert-Equal 0 (Get-RetryDelaySeconds -FailureCount 0) "Zero failures should not delay recovery."
  }

  Invoke-Case "redacts authorization headers, token assignments and explicit secrets" {
    $secret = "do-not-log-this-explicit-secret"
    $text = "Authorization: Bearer abc.def`nOCR_API_TOKEN=worker-token`nDEEPSEEK_API_KEY='model-key'`nmessage=$secret"
    $protected = Protect-LogText -Text $text -SecretValues @($secret)
    foreach ($value in @("abc.def", "worker-token", "model-key", $secret)) {
      Assert-True (-not $protected.Contains($value)) "Protected log text exposed a secret value."
    }
    Assert-True $protected.Contains("[REDACTED]") "Protected log text did not mark redacted values."
  }

  Invoke-Case "rotates bounded logs without retaining excess backups" {
    $log = Join-Path $testRoot "bounded.log"
    for ($index = 0; $index -lt 100; $index++) {
      Write-ServiceLog -Path $log -Message ("x" * 2048) -MaxBytes 1024 -Backups 5
    }
    Assert-True (Test-Path -LiteralPath $log) "Current log file was not created."
    for ($backup = 1; $backup -le 5; $backup++) {
      Assert-True (Test-Path -LiteralPath "$log.$backup") "Expected log backup $backup was not retained."
    }
    Assert-True (-not (Test-Path -LiteralPath "$log.6")) "Log rotation retained more than five backups."
    $totalBytes = (Get-ChildItem -LiteralPath $testRoot -Filter "bounded.log*" | Measure-Object -Property Length -Sum).Sum
    Assert-True ($totalBytes -le (6 * 4096)) "Rotated logs exceeded the bounded test budget."
  }

  Invoke-Case "atomically writes and strictly reads runtime state" {
    $statePath = Join-Path $testRoot "runtime-state.json"
    $state = New-ServiceRuntimeState -DesiredState "running"
    $state.services.api.state = "ready"
    Write-RuntimeState -Path $statePath -State $state
    $loaded = Read-RuntimeState -Path $statePath
    Assert-Equal 1 $loaded.schemaVersion "Runtime state schema was not preserved."
    Assert-Equal "running" $loaded.desiredState "Desired state was not preserved."
    Assert-Equal "ready" $loaded.services.api.state "Nested service state was not preserved."
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $testRoot -Filter "runtime-state.json.*.tmp").Count "Atomic state write left a temporary file."

    $state.services.api.state = "degraded"
    Write-RuntimeState -Path $statePath -State $state
    Assert-Equal "degraded" (Read-RuntimeState -Path $statePath).services.api.state "Atomic state overwrite did not replace the previous file."
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $testRoot -Filter "runtime-state.json.*.bak").Count "Atomic state overwrite left a backup file."

    Set-Content -LiteralPath $statePath -Encoding UTF8 -Value '{"schemaVersion":1,"desiredState":"running","supervisorPid":0,"updatedAt":"invalid","services":{}}'
    Assert-Rejected { Read-RuntimeState -Path $statePath } "Malformed runtime state was accepted."
  }

  Invoke-Case "matches only an existing process with the expected command identity" {
    Assert-True (Test-OwnedProcess -ProcessId $PID -ExpectedCommandFragment "powershell") "Current PowerShell process identity was not recognized."
    Assert-True (-not (Test-OwnedProcess -ProcessId $PID -ExpectedCommandFragment "definitely-not-the-current-command")) "Mismatched process identity was accepted."
    Assert-True (-not (Test-OwnedProcess -ProcessId 2147483647 -ExpectedCommandFragment "powershell")) "Missing process was accepted as owned."
  }

  Invoke-Case "builds only fixed remote worker control commands" {
    $configPath = Join-Path $testRoot "remote-config.json"
    Set-Content -LiteralPath $configPath -Encoding UTF8 -Value '{"sshHost":"models.example.com","sshUser":"resume_user","sshPort":2222,"remoteRoot":"/home/resume_user/resume-ai"}'
    $config = Read-ServiceConfig -Path $configPath
    $expectedStart = @(
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
      "resume_user@models.example.com", "-p", "2222",
      "/home/resume_user/resume-ai/services/bin/start-all.sh"
    )
    Assert-Equal ($expectedStart -join "`n") ((Get-RemoteControlSshArguments -Config $config -Command "start") -join "`n") "Remote start arguments were not exact."
    Assert-True ((Get-RemoteControlSshArguments -Config $config -Command "status")[-1] -eq "/home/resume_user/resume-ai/services/bin/status.sh") "Remote status did not use the fixed status script."
    Assert-True ((Get-RemoteControlSshArguments -Config $config -Command "stop")[-1] -eq "/home/resume_user/resume-ai/services/bin/stop-all.sh") "Remote stop did not use the fixed stop script."
    Assert-Rejected { Get-RemoteControlSshArguments -Config $config -Command "restart" } "Non-whitelisted remote command was accepted."
  }

  Invoke-Case "invokes SSH with a separate argument array and redacts remote failures" {
    $configPath = Join-Path $testRoot "invoke-config.json"
    Set-Content -LiteralPath $configPath -Encoding UTF8 -Value '{"sshHost":"models.example.com","sshUser":"resume_user","sshPort":2222,"remoteRoot":"/home/resume_user/resume-ai"}'
    $config = Read-ServiceConfig -Path $configPath
    $capturePath = Join-Path $testRoot "ssh-arguments.txt"
    $fakeSsh = Join-Path $testRoot "fake-ssh.ps1"
    Set-Content -LiteralPath $fakeSsh -Encoding UTF8 -Value @'
$args | Set-Content -LiteralPath $env:APPLIOT_TEST_SSH_CAPTURE -Encoding UTF8
Write-Error "Authorization: Bearer remote-secret"
exit 7
'@
    $env:APPLIOT_TEST_SSH_CAPTURE = $capturePath
    $message = ""
    try {
      Invoke-RemoteWorkerCommand -Config $config -Command "status" -SshExecutable "powershell.exe" -SshPrefixArguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $fakeSsh)
    } catch {
      $message = $_.Exception.Message
    } finally {
      Remove-Item Env:APPLIOT_TEST_SSH_CAPTURE -ErrorAction SilentlyContinue
    }
    Assert-True $message.Contains("Remote worker command failed") "Remote SSH failure did not use a stable error."
    Assert-True (-not $message.Contains("remote-secret")) "Remote SSH failure exposed a bearer token."
    $captured = @(Get-Content -LiteralPath $capturePath -Encoding UTF8)
    Assert-True ($captured -contains "/home/resume_user/resume-ai/services/bin/status.sh") "Remote command was not passed as one fixed argument."
  }

  Invoke-Case "starts one managed process, probes it and stops only the owned identity" {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    $marker = Join-Path $testRoot "managed.marker"
    $stdout = Join-Path $testRoot "managed.stdout.log"
    $stderr = Join-Path $testRoot "managed.stderr.log"
    $fixture = Join-Path $PSScriptRoot "fixtures\fake-managed-service.ps1"
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $fixture, "-Port", [string]$port, "-MarkerPath", $marker)
    $record = Start-ManagedProcess -Executable "powershell.exe" -Arguments $arguments -WorkingDirectory $testRoot -StdoutPath $stdout -StderrPath $stderr -CommandIdentity "fake-managed-service.ps1"
    try {
      Assert-True (Wait-ServiceReady -Probe { Test-TcpPort -HostName "127.0.0.1" -Port $port -TimeoutMilliseconds 200 } -TimeoutSeconds 10 -PollMilliseconds 50) "Managed TCP service did not become ready."
      Assert-True (Test-OwnedProcess -ProcessId $record.processId -ExpectedCommandFragment "fake-managed-service.ps1") "Managed process identity was not recorded correctly."
      $duplicate = Start-ManagedProcess -Executable "powershell.exe" -Arguments $arguments -WorkingDirectory $testRoot -StdoutPath $stdout -StderrPath $stderr -CommandIdentity "fake-managed-service.ps1" -ExistingProcessId $record.processId
      Assert-Equal $record.processId $duplicate.processId "Idempotent start created a second process."
      Assert-True (Invoke-WebHealthProbe -Uri "http://127.0.0.1:$port/readyz" -TimeoutMilliseconds 1000) "HTTP health probe did not accept a successful response."
      $json = Invoke-JsonHealthProbe -Uri "http://127.0.0.1:$port/readyz" -TimeoutMilliseconds 1000
      Assert-Equal "ready" $json.status "JSON health probe did not parse the response."
      Assert-True (-not (Stop-ManagedProcess -ProcessId $record.processId -CommandIdentity "wrong-identity" -TimeoutSeconds 1)) "Stop accepted a mismatched process identity."
      Assert-True (Stop-ManagedProcess -ProcessId $record.processId -CommandIdentity "fake-managed-service.ps1" -TimeoutSeconds 5) "Owned managed process did not stop."
      Assert-True (-not (Test-OwnedProcess -ProcessId $record.processId -ExpectedCommandFragment "fake-managed-service.ps1")) "Managed process remained alive after stop."
    } finally {
      Stop-Process -Id $record.processId -Force -ErrorAction SilentlyContinue
    }
  }

  Invoke-Case "wait readiness observes an explicit stop request" {
    $counter = [pscustomobject]@{ attempts = 0 }
    $ready = Wait-ServiceReady -Probe { $counter.attempts++; return $false } -TimeoutSeconds 5 -PollMilliseconds 10 -StopRequested { return $counter.attempts -ge 2 }
    Assert-True (-not $ready) "Readiness wait ignored the explicit stop request."
    Assert-True ($counter.attempts -lt 10) "Readiness wait did not stop promptly."
  }

  Invoke-Case "selects bounded recovery actions without restarting warm or stopped services" {
    Assert-Equal "none" (Get-ServiceRecoveryAction -ServiceName "api" -DesiredState "stopped" -ProcessAlive $false -Healthy $false -FailureCount 9 -InWarmup $false) "Stopped services should not recover."
    Assert-Equal "none" (Get-ServiceRecoveryAction -ServiceName "remoteOcr" -DesiredState "running" -ProcessAlive $true -Healthy $false -FailureCount 3 -InWarmup $true) "Warm remote service should not restart."
    Assert-Equal "restart-local" (Get-ServiceRecoveryAction -ServiceName "api" -DesiredState "running" -ProcessAlive $false -Healthy $false -FailureCount 1 -InWarmup $false) "Dead API did not request local restart."
    Assert-Equal "restart-local" (Get-ServiceRecoveryAction -ServiceName "api" -DesiredState "running" -ProcessAlive $true -Healthy $false -FailureCount 3 -InWarmup $false) "Repeated API health failures did not request local restart."
    Assert-Equal "none" (Get-ServiceRecoveryAction -ServiceName "api" -DesiredState "running" -ProcessAlive $true -Healthy $false -FailureCount 2 -InWarmup $false) "Live API restarted before three failed health checks."
    Assert-Equal "reconnect-tunnel" (Get-ServiceRecoveryAction -ServiceName "tunnel" -DesiredState "running" -ProcessAlive $false -Healthy $false -FailureCount 1 -InWarmup $false) "Dead tunnel did not request reconnection."
    Assert-Equal "reconnect-tunnel" (Get-ServiceRecoveryAction -ServiceName "tunnel" -DesiredState "running" -ProcessAlive $true -Healthy $false -FailureCount 1 -InWarmup $false) "Unhealthy live tunnel did not request reconnection."
    Assert-Equal "inspect-remote" (Get-ServiceRecoveryAction -ServiceName "remoteEmbedding" -DesiredState "running" -ProcessAlive $true -Healthy $false -FailureCount 3 -InWarmup $false) "Repeated remote health failure did not request inspection."
    Assert-Equal "none" (Get-ServiceRecoveryAction -ServiceName "remoteEmbedding" -DesiredState "running" -ProcessAlive $true -Healthy $false -FailureCount 2 -InWarmup $false) "Remote inspection occurred before three failures."
  }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
  throw "$script:failures service supervisor PowerShell test case(s) failed."
}

Write-Output "All service supervisor PowerShell tests passed."
