param(
  [int]$Port = 8420,
  [int]$TimeoutSeconds = 45
)

$ProgressPreference = 'SilentlyContinue'

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 2
    $health = $response.Content | ConvertFrom-Json
    if ($health.ready -eq $true) { exit 0 }
  } catch { }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

exit 1
