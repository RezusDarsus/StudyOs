$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$maven = Join-Path $projectRoot 'tools\maven\bin\mvn.cmd'
$env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'User')
$env:STUDYOS_AI_PROVIDER = [Environment]::GetEnvironmentVariable('STUDYOS_AI_PROVIDER', 'User')
$env:STUDYOS_AI_CHAT_MODEL = [Environment]::GetEnvironmentVariable('STUDYOS_AI_CHAT_MODEL', 'User')
$env:STUDYOS_AI_EMBEDDING_MODEL = [Environment]::GetEnvironmentVariable('STUDYOS_AI_EMBEDDING_MODEL', 'User')
$env:STUDYOS_AI_CHAT_MAX_OUTPUT_TOKENS = [Environment]::GetEnvironmentVariable('STUDYOS_AI_CHAT_MAX_OUTPUT_TOKENS', 'User')
$env:STUDYOS_AI_PREDICTION_MAX_OUTPUT_TOKENS = [Environment]::GetEnvironmentVariable('STUDYOS_AI_PREDICTION_MAX_OUTPUT_TOKENS', 'User')
$env:NVIDIA_API_KEY = [Environment]::GetEnvironmentVariable('NVIDIA_API_KEY', 'User')
$env:STUDYOS_PORT = [Environment]::GetEnvironmentVariable('STUDYOS_PORT', 'User')
$env:STUDYOS_UI_ROOT = $projectRoot
$docker = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
if (Test-Path $docker) {
  & $docker compose -f (Join-Path $projectRoot 'backend\docker-compose.yml') up -d
  if ($LASTEXITCODE -ne 0) { throw 'Docker/PostgreSQL could not start. Open Docker Desktop and try again.' }
  Start-Sleep -Seconds 3
}
$port = if ($env:STUDYOS_PORT) { [int]$env:STUDYOS_PORT } else { 8081 }
# Another application on this machine owns 8080, so a listener alone proves nothing. Ask the port whether
# it is StudyOS before reporting it as already running, otherwise a neighbour's app reads as a false green.
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  $isStudyOS = $false
  try { $isStudyOS = (Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 4) -ne $null } catch { $isStudyOS = $false }
  if ($isStudyOS) {
    Write-Host "StudyOS backend is already running at http://localhost:$port/" -ForegroundColor Green
    exit 0
  }
  throw "Port $port is taken by something that is not StudyOS. Set STUDYOS_PORT to a free port and rerun."
}
& $maven -f (Join-Path $projectRoot 'backend\pom.xml') spring-boot:run
