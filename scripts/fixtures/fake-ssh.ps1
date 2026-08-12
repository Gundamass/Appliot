[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArguments)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrEmpty($env:APPLIOT_FAKE_SSH_EVENTS)) {
  Add-Content -LiteralPath $env:APPLIOT_FAKE_SSH_EVENTS -Encoding UTF8 -Value ($RemainingArguments -join " ")
}
if ($RemainingArguments -contains "-N") {
  while ($true) { Start-Sleep -Seconds 1 }
}
exit 0
