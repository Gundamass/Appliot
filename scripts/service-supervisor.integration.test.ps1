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

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "appliot-supervisor-integration-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
  Invoke-Case "starts and stops the dependency chain in exact order" {
    $events = [Collections.Generic.List[string]]::new()
    $state = New-ServiceRuntimeState -DesiredState "running"
    $operations = @{
      StartRemote = { $events.Add("remote-start"); return $true }
      StartTunnel = { $events.Add("tunnel-start"); return [pscustomobject]@{ processId = 101; commandIdentity = "ssh" } }
      WaitTunnel = { return $true }
      StartApi = { $events.Add("api-start"); return [pscustomobject]@{ processId = 102; commandIdentity = "server.js" } }
      WaitApi = { return $true }
      StartWeb = { $events.Add("web-start"); return [pscustomobject]@{ processId = 103; commandIdentity = "serve-web.mjs" } }
      WaitWeb = { return $true }
      StopWeb = { $events.Add("web-stop"); return $true }
      StopApi = { $events.Add("api-stop"); return $true }
      StopTunnel = { $events.Add("tunnel-stop"); return $true }
      StopRemote = { $events.Add("remote-stop"); return $true }
    }
    Invoke-ServiceStartSequence -State $state -Operations $operations
    Assert-Equal "remote-start,tunnel-start,api-start,web-start" (($events | Select-Object -First 4) -join ",") "Startup order was incorrect."
    Assert-Equal "ready" $state.services.remoteOcr.state "Remote OCR was not marked ready."
    Assert-Equal 102 $state.services.api.processId "API process identity was not stored."
    Invoke-ServiceStopSequence -State $state -Operations $operations
    Assert-Equal "web-stop,api-stop,tunnel-stop,remote-stop" (($events | Select-Object -Last 4) -join ",") "Shutdown order was incorrect."
    Assert-Equal "stopped" $state.services.web.state "Web was not marked stopped."
    Assert-Equal $null $state.services.api.processId "API PID was retained after stop."
  }

  Invoke-Case "publishes startup state before a slow remote start returns" {
    $state = New-ServiceRuntimeState -DesiredState "running"
    $published = [Collections.Generic.List[string]]::new()
    $operations = @{
      StartRemote = {
        Assert-Equal "starting" $state.services.remoteOcr.state "Remote OCR was not marked starting before the remote call."
        Assert-Equal "starting" $state.services.remoteEmbedding.state "Remote embedding was not marked starting before the remote call."
        Assert-Equal "starting,starting" $published[0] "Startup state was not published before the remote call."
        return $true
      }
      StartTunnel = { return [pscustomobject]@{ processId = 101; commandIdentity = "ssh" } }
      WaitTunnel = { return $true }
      StartApi = { return [pscustomobject]@{ processId = 102; commandIdentity = "server.js" } }
      WaitApi = { return $true }
      StartWeb = { return [pscustomobject]@{ processId = 103; commandIdentity = "serve-web.mjs" } }
      WaitWeb = { return $true }
    }

    Invoke-ServiceStartSequence -State $state -Operations $operations -PublishState {
      param($current)
      $published.Add("$($current.services.remoteOcr.state),$($current.services.remoteEmbedding.state)")
    }

    Assert-True ($published.Count -ge 5) "Startup stages were not published as they changed."
    Assert-Equal "ready" $state.services.web.state "Web did not finish ready after published startup."
  }

  Invoke-Case "stops startup immediately when desired state changes" {
    $events = [Collections.Generic.List[string]]::new()
    $state = New-ServiceRuntimeState -DesiredState "running"
    $operations = @{
      StartRemote = { $events.Add("remote-start"); $state.desiredState = "stopped"; return $true }
      StartTunnel = { $events.Add("tunnel-start"); throw "must not run" }
      WaitTunnel = { return $true }
      StartApi = { throw "must not run" }
      WaitApi = { return $true }
      StartWeb = { throw "must not run" }
      WaitWeb = { return $true }
    }
    Invoke-ServiceStartSequence -State $state -Operations $operations
    Assert-Equal "remote-start" ($events -join ",") "Startup ignored the stopped desired state."
  }

  Invoke-Case "recovers only the failed local dependency after the recorded backoff" {
    $events = [Collections.Generic.List[string]]::new()
    $state = New-ServiceRuntimeState -DesiredState "running"
    foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) { $state.services.$name.state = "ready" }
    $state.services.tunnel.processId = 101
    $state.services.tunnel.commandIdentity = "ssh"
    $state.services.api.processId = 102
    $state.services.api.commandIdentity = "server.js"
    $state.services.web.processId = 103
    $state.services.web.commandIdentity = "serve-web.mjs"
    $operations = @{
      IsTunnelAlive = { return $false }
      ProbeTunnel = { return $false }
      RestartTunnel = { $events.Add("tunnel-restart"); return [pscustomobject]@{ processId = 201; commandIdentity = "ssh" } }
      IsApiAlive = { return $true }
      ProbeApi = { return $true }
      RestartApi = { $events.Add("api-restart"); throw "must not run" }
      IsWebAlive = { return $true }
      ProbeWeb = { return $true }
      RestartWeb = { $events.Add("web-restart"); throw "must not run" }
      ProbeRemoteOcr = { return $true }
      ProbeRemoteEmbedding = { return $true }
      InspectRemote = { throw "must not run" }
      RestartRemote = { throw "must not run" }
    }
    $startedAt = [DateTime]::UtcNow
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt
    Assert-Equal "" ($events -join ",") "Recovery ignored the initial backoff."
    Assert-Equal "retrying" $state.services.tunnel.state "Failed tunnel was not marked retrying."
    Assert-True ($null -ne $state.services.tunnel.nextRetryAt) "Tunnel retry time was not recorded."
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt.AddSeconds(1)
    Assert-Equal "" ($events -join ",") "Tunnel restarted before the retry deadline."
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt.AddSeconds(2)
    Assert-Equal "tunnel-restart" ($events -join ",") "Recovery did not restart the failed tunnel at the retry deadline."
    Assert-Equal 201 $state.services.tunnel.processId "Recovered tunnel PID was not stored."
    Assert-Equal 1 $state.services.tunnel.restartCount "Tunnel restart count was not incremented."
    Assert-Equal 0 $state.services.api.restartCount "Healthy API restart count changed."
  }

  Invoke-Case "restarts a live API only after repeated functional failures" {
    $events = [Collections.Generic.List[string]]::new()
    $state = New-ServiceRuntimeState -DesiredState "running"
    foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) { $state.services.$name.state = "ready" }
    $state.services.api.processId = 102
    $state.services.api.commandIdentity = "server.js"
    $operations = @{
      IsTunnelAlive = { return $true }
      ProbeTunnel = { return $true }
      RestartTunnel = { throw "must not run" }
      IsApiAlive = { return $true }
      ProbeApi = { return $false }
      RestartApi = { $events.Add("api-restart"); return [pscustomobject]@{ processId = 202; commandIdentity = "server.js" } }
      IsWebAlive = { return $true }
      ProbeWeb = { return $true }
      RestartWeb = { throw "must not run" }
      ProbeRemoteOcr = { return $true }
      ProbeRemoteEmbedding = { return $true }
      InspectRemote = { throw "must not run" }
      RestartRemote = { throw "must not run" }
    }
    $startedAt = [DateTime]::UtcNow
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt.AddMilliseconds(100)
    Assert-Equal "" ($events -join ",") "API restarted before three failed health checks."
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt.AddMilliseconds(200)
    Assert-Equal "retrying" $state.services.api.state "Repeated API failure did not schedule a restart."
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now $startedAt.AddSeconds(3)
    Assert-Equal "api-restart" ($events -join ",") "API did not restart after its retry deadline."
    Assert-Equal 202 $state.services.api.processId "Restarted API PID was not stored."
  }

  Invoke-Case "inspects and restarts remote workers only after three failures" {
    $events = [Collections.Generic.List[string]]::new()
    $state = New-ServiceRuntimeState -DesiredState "running"
    foreach ($name in @("remoteOcr", "remoteEmbedding", "tunnel", "api", "web")) { $state.services.$name.state = "ready" }
    $state.services.remoteOcr.failureCount = 2
    $state.services.remoteEmbedding.failureCount = 2
    $operations = @{
      IsTunnelAlive = { return $true }
      ProbeTunnel = { return $true }
      RestartTunnel = { throw "must not run" }
      IsApiAlive = { return $true }
      ProbeApi = { return $true }
      RestartApi = { throw "must not run" }
      IsWebAlive = { return $true }
      ProbeWeb = { return $true }
      RestartWeb = { throw "must not run" }
      ProbeRemoteOcr = { return $false }
      ProbeRemoteEmbedding = { return $false }
      InspectRemote = { $events.Add("remote-inspect"); return $false }
      RestartRemote = { $events.Add("remote-restart"); return $true }
    }
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now ([DateTime]::UtcNow)
    Assert-Equal "remote-inspect,remote-restart" ($events -join ",") "Remote recovery did not inspect before restarting."
    Assert-Equal 1 $state.services.remoteOcr.restartCount "Remote OCR restart count was not incremented."
    Assert-Equal 0 $state.services.remoteEmbedding.failureCount "Remote failure count was not reset after restart."
    Assert-True ($null -ne $state.services.remoteOcr.nextRetryAt) "Remote restart did not record a warmup deadline."

    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now ([DateTime]::UtcNow.AddSeconds(30))
    Assert-Equal 0 $state.services.remoteOcr.failureCount "Remote warmup was counted as a failure."
    Invoke-ServiceRecoveryCycle -State $state -Operations $operations -Now ([DateTime]::UtcNow.AddSeconds(121))
    Assert-Equal 1 $state.services.remoteOcr.failureCount "Remote failure was not counted after warmup expired."
  }

  Invoke-Case "holds an exclusive supervisor lock" {
    $lockPath = Join-Path $testRoot "supervisor.lock"
    $first = Enter-ServiceSupervisorLock -Path $lockPath
    try {
      $second = Enter-ServiceSupervisorLock -Path $lockPath
      Assert-Equal $null $second "A second supervisor acquired the same lock."
    } finally {
      Exit-ServiceSupervisorLock -Lock $first -Path $lockPath
    }
    $third = Enter-ServiceSupervisorLock -Path $lockPath
    Assert-True ($null -ne $third) "Supervisor lock was not released."
    Exit-ServiceSupervisorLock -Lock $third -Path $lockPath
  }

  Invoke-Case "supervisor entry uses the tested lifecycle primitives without expression evaluation" {
    $scriptText = Get-Content -LiteralPath (Join-Path $PSScriptRoot "service-supervisor.ps1") -Raw -Encoding UTF8
    foreach ($required in @(
      "Enter-ServiceSupervisorLock",
      "Invoke-ServiceStartSequence",
      "Invoke-ServiceRecoveryCycle",
      "Invoke-ServiceStopSequence",
      "Write-RuntimeState"
    )) {
      Assert-True $scriptText.Contains($required) "Supervisor entry does not use $required."
    }
    Assert-True (-not $scriptText.Contains("Invoke-Expression")) "Supervisor entry uses expression evaluation."
    Assert-True ($scriptText -notmatch '(?<!\d)(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?!\d)') "Supervisor entry hard-codes a private remote address."
  }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
  throw "$script:failures service supervisor integration test case(s) failed."
}

Write-Output "All service supervisor integration tests passed."
