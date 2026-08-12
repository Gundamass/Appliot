[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$MarkerPath,
  [int]$StartupDelayMilliseconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($StartupDelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $StartupDelayMilliseconds }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
Set-Content -LiteralPath $MarkerPath -Encoding UTF8 -Value $PID

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      while ($true) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($line)) { break }
      }
      $body = '{"status":"ready"}'
      $bytes = [Text.Encoding]::UTF8.GetBytes($body)
      $header = "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
      $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
    } catch [IO.IOException] {
      # A TCP-only health probe can close before an HTTP response is written.
    } finally {
      $client.Dispose()
    }
  }
} finally {
  $listener.Stop()
}
