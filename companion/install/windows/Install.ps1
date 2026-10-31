$ErrorActionPreference = 'Stop'
$appDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'GravaSimples'
$configDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'GravaSimples'
$configPath = Join-Path $configDirectory 'pairing.json'
$executable = Join-Path $appDirectory 'GravaSimplesCompanion.exe'
$airplayDirectory = Join-Path $appDirectory 'airplay'
$airplayExecutable = Join-Path $airplayDirectory 'popyachsa-airplay.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'GravaSimplesCompanion'

try {
  $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  try { $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
  $target = switch ($architecture.ToLowerInvariant()) {
    'arm64' { 'arm64' }
    'amd64' { 'amd64' }
    'x64' { 'amd64' }
    default { throw 'Este instalador requer Windows ARM64 ou x64 de 64 bits.' }
  }
  $payload = Join-Path $PSScriptRoot ("binaries\GravaSimplesCompanion-windows-$target.exe")
  if (-not (Test-Path -LiteralPath $payload -PathType Leaf)) { throw 'Extraia o ZIP completo antes de abrir Install.cmd.' }
  Write-Host 'Instalando o controle local do GravaSimples para este usuario...'
  New-Item -ItemType Directory -Path $appDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  if (Test-Path -LiteralPath $executable) {
    & $executable --stop --config $configPath 2>$null | Out-Null
    Start-Sleep -Milliseconds 300
  }

  # Update only the executable; pairing.json survives upgrades.
  Copy-Item -LiteralPath $payload -Destination ($executable + '.new') -Force
  $replaced = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try { Move-Item -LiteralPath ($executable + '.new') -Destination $executable -Force; $replaced = $true; break }
    catch { Start-Sleep -Milliseconds 150 }
  }
  if (-not $replaced) { throw 'O controle anterior ainda esta aberto. Feche-o e abra Install.cmd novamente.' }
  $airplayPayloadDirectory = Join-Path $PSScriptRoot 'airplay'
  $airplayPayload = Join-Path $airplayPayloadDirectory 'popyachsa-airplay.exe'
  if (-not (Test-Path -LiteralPath $airplayPayload -PathType Leaf)) { $airplayPayload = Join-Path $airplayPayloadDirectory 'uxplay.exe' }
  if (Test-Path -LiteralPath $airplayPayload -PathType Leaf) {
    New-Item -ItemType Directory -Path $airplayDirectory -Force | Out-Null
    Copy-Item -Path (Join-Path $airplayPayloadDirectory '*') -Destination $airplayDirectory -Recurse -Force
  }
  foreach ($document in @('Uninstall.ps1', 'Uninstall.cmd', 'COPYING.txt', 'THIRD-PARTY-NOTICES.txt', 'LEIA-ME.txt')) {
    $source = Join-Path $PSScriptRoot $document
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $appDirectory $document) -Force }
  }

  # Per-user login startup; no administrator access, service or firewall rule.
  $arguments = '--config "' + $configPath + '" --airplay-bin "' + $airplayExecutable + '"'
  $startupCommand = '"' + $executable + '" ' + $arguments
  if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
  New-ItemProperty -LiteralPath $runKey -Name $runName -Value $startupCommand -PropertyType String -Force | Out-Null
  $process = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { throw 'O controle nao iniciou. A porta 4455 pode estar ocupada ou o Windows pode ter bloqueado o aplicativo.' }
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4455/health' -TimeoutSec 3
  if ($health.name -ne 'grava-simples-companion') { throw 'A porta 4455 esta sendo usada por outro aplicativo.' }
  Write-Host 'Instalacao concluida. O controle inicia automaticamente ao entrar neste usuario.'
  Write-Host 'Abra o estudio GravaSimples no Chrome e mantenha o celular na mesma rede Wi-Fi.'
  Write-Host 'Se o Windows solicitar acesso a rede, permita na sua rede privada para usar o OBS Blade.'
  Write-Host "Para remover, abra Uninstall.cmd nesta pasta ou em $appDirectory."
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
