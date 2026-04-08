param(
  [Parameter(Mandatory = $true)]
  [string]$RenderServiceName,

  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl
)

$ErrorActionPreference = "Stop"

if (-not $env:RENDER_TOKEN) {
  Write-Error "RENDER_TOKEN absent. Definis d'abord la variable d'environnement RENDER_TOKEN."
  exit 1
}

$headers = @{
  Authorization = "Bearer $($env:RENDER_TOKEN)"
  Accept        = "application/json"
  "Content-Type" = "application/json"
}

$services = Invoke-RestMethod -Uri "https://api.render.com/v1/services?limit=100" -Headers $headers -Method Get
$service = $null
foreach ($item in $services) {
  if ($item.service.name -eq $RenderServiceName) {
    $service = $item.service
    break
  }
}

if (-not $service) {
  Write-Error "Service Render introuvable: $RenderServiceName"
  exit 1
}

$envVarsRaw = Invoke-RestMethod -Uri "https://api.render.com/v1/services/$($service.id)/env-vars?limit=100" -Headers $headers -Method Get
$envMap = @{}
foreach ($entry in $envVarsRaw) {
  if ($entry.envVar -and $entry.envVar.key) {
    $envMap[$entry.envVar.key] = $entry.envVar.value
  }
}

$envMap["STORAGE_BACKEND"] = "postgres"
$envMap["DATABASE_URL"] = $DatabaseUrl

$payload = @()
foreach ($key in $envMap.Keys) {
  $payload += @{
    key = $key
    value = $envMap[$key]
  }
}

Invoke-RestMethod -Uri "https://api.render.com/v1/services/$($service.id)/env-vars" -Headers $headers -Method Put -Body ($payload | ConvertTo-Json -Depth 6)

Write-Output "Variables Render mises a jour pour '$RenderServiceName'."
Write-Output "Render va redeployer automatiquement le service."
