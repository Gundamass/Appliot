Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "local-launch.psm1") -Force

$script:failures = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Message)
  if ($Expected -ne $Actual) { throw $Message }
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

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "resume-local-launch-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
  Invoke-Case "uses process environment when the env file is absent" {
    $effective = Get-EffectiveEnvironment -EnvFile (Join-Path $testRoot "missing.env") -ProcessEnvironment @{
      DATABASE_FILE = "process/database.sqlite"
      DEEPSEEK_API_KEY = "process-key"
    }
    Assert-Equal "process/database.sqlite" $effective["DATABASE_FILE"] "DATABASE_FILE did not come from process environment."
    Assert-Equal "process-key" $effective["DEEPSEEK_API_KEY"] "DEEPSEEK_API_KEY did not come from process environment."
  }

  Invoke-Case "uses file values when process variables are absent" {
    $envFile = Join-Path $testRoot "file-only.env"
    Set-Content -LiteralPath $envFile -Encoding UTF8 -Value @(
      "DATABASE_FILE=data/file.sqlite",
      "DEEPSEEK_API_KEY=file-key"
    )
    $effective = Get-EffectiveEnvironment -EnvFile $envFile -ProcessEnvironment @{}
    Assert-Equal "data/file.sqlite" $effective["DATABASE_FILE"] "DATABASE_FILE did not come from the env file."
    Assert-Equal "file-key" $effective["DEEPSEEK_API_KEY"] "DEEPSEEK_API_KEY did not come from the env file."
  }

  Invoke-Case "gives process environment precedence over file values" {
    $envFile = Join-Path $testRoot "override.env"
    Set-Content -LiteralPath $envFile -Encoding UTF8 -Value @(
      "DATABASE_FILE=data/file.sqlite",
      "DEEPSEEK_API_KEY=file-key"
    )
    $effective = Get-EffectiveEnvironment -EnvFile $envFile -ProcessEnvironment @{
      DATABASE_FILE = "data/process.sqlite"
      DEEPSEEK_API_KEY = "process-key"
    }
    Assert-Equal "data/process.sqlite" $effective["DATABASE_FILE"] "Process DATABASE_FILE did not override the file."
    Assert-Equal "process-key" $effective["DEEPSEEK_API_KEY"] "Process DEEPSEEK_API_KEY did not override the file."
  }

  Invoke-Case "parses supported quoting and comments without executing contents" {
    $envFile = Join-Path $testRoot "quoting.env"
    $marker = Join-Path $testRoot "must-not-exist.txt"
    Set-Content -LiteralPath $envFile -Encoding UTF8 -Value @(
      "# full-line comment",
      'DATABASE_FILE = "data/quoted database.sqlite" # trailing comment',
      "DEEPSEEK_API_KEY='quoted#key'",
      'LITERAL_COMMAND=$(Set-Content -LiteralPath must-not-exist.txt -Value unsafe)',
      "EMPTY_VALUE= # empty value"
    )
    $effective = Get-EffectiveEnvironment -EnvFile $envFile -ProcessEnvironment @{}
    Assert-Equal "data/quoted database.sqlite" $effective["DATABASE_FILE"] "Double-quoted value was parsed incorrectly."
    Assert-Equal "quoted#key" $effective["DEEPSEEK_API_KEY"] "Single-quoted hash was parsed as a comment."
    Assert-True ($effective["LITERAL_COMMAND"].StartsWith('$(')) "Command-like text was not preserved literally."
    Assert-Equal "" $effective["EMPTY_VALUE"] "Empty unquoted value was parsed incorrectly."
    Assert-True (-not (Test-Path -LiteralPath $marker)) "Env file contents were executed."
  }

  Invoke-Case "resolves the effective database directory and optional names" {
    $effective = Get-EffectiveEnvironment -EnvFile (Join-Path $testRoot "missing.env") -ProcessEnvironment @{
      DATABASE_FILE = "state/resume.sqlite"
      DEEPSEEK_API_KEY = "configured-key"
    }
    $databaseDirectory = Get-EffectiveDatabaseDirectory -WorkingDirectory $testRoot -Environment $effective
    $missing = @(Get-MissingOptionalAdapterVariables -Environment $effective)
    Assert-Equal (Join-Path $testRoot "state") $databaseDirectory "Effective database directory was not resolved from merged configuration."
    Assert-True (-not ($missing -contains "DEEPSEEK_API_KEY")) "Configured DeepSeek variable was reported missing."
    Assert-True ($missing -contains "EMBEDDING_BASE_URL") "Missing embedding variable name was not reported."
    Assert-True ($missing -contains "OCR_API_TOKEN") "Missing OCR variable name was not reported."
  }

  Invoke-Case "does not expose secret values in helper output or parse errors" {
    $secret = "do-not-print-powershell-secret"
    $envFile = Join-Path $testRoot "secret.env"
    Set-Content -LiteralPath $envFile -Encoding UTF8 -Value "DEEPSEEK_API_KEY=$secret"
    $effective = Get-EffectiveEnvironment -EnvFile $envFile -ProcessEnvironment @{}
    $output = @(Get-MissingOptionalAdapterVariables -Environment $effective) -join "`n"
    Assert-True (-not $output.Contains($secret)) "Optional-variable output exposed a secret value."

    $invalidFile = Join-Path $testRoot "invalid.env"
    Set-Content -LiteralPath $invalidFile -Encoding UTF8 -Value "INVALID LINE $secret"
    $message = ""
    try {
      Get-EffectiveEnvironment -EnvFile $invalidFile -ProcessEnvironment @{} | Out-Null
    } catch {
      $message = $_.Exception.Message
    }
    Assert-True $message.Contains("line 1") "Malformed env input did not identify its line safely."
    Assert-True (-not $message.Contains($secret)) "Malformed env error exposed file contents."
  }

  Invoke-Case "does not expose the database path when writability preflight fails" {
    $secret = "do-not-print-database-path-secret"
    $blockingFile = Join-Path $testRoot "blocked-$secret"
    Set-Content -LiteralPath $blockingFile -Encoding UTF8 -Value "not a directory"
    $message = ""
    try {
      Assert-DatabaseDirectoryWritable -Directory (Join-Path $blockingFile "nested")
    } catch {
      $message = $_.Exception.Message
    }
    Assert-True $message.Contains("DATABASE_FILE") "Database writability error did not identify the variable name."
    Assert-True (-not $message.Contains($secret)) "Database writability error exposed the configured path."
  }
} finally {
  Remove-Item -LiteralPath $testRoot -Recurse -Force
}

if ($script:failures -gt 0) {
  throw "$script:failures PowerShell test case(s) failed."
}

Write-Output "All local launch PowerShell tests passed."
