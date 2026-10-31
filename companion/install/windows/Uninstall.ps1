param([switch]$RemovePairing)
$ErrorActionPreference = 'Stop'
$appDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'GravaSimples'
$configDirectory = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'GravaSimples'
$configPath = Join-Path $configDirectory 'pairing.json'
$executable = Join-Path $appDirectory 'GravaSimplesCompanion.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
try {
  Remove-ItemProperty -LiteralPath $runKey -Name 'GravaSimplesCompanion' -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $executable) {
    & $executable --stop --config $configPath 2>$null | Out-Null
    Start-Sleep -Milliseconds 300
    $removed = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try { Remove-Item -LiteralPath $executable -Force; $removed = $true; break }
      catch { Start-Sleep -Milliseconds 150 }
    }
    if (-not $removed) { throw 'O controle ainda esta aberto. Tente desinstalar novamente.' }
  }
  foreach ($document in @('COPYING.txt', 'THIRD-PARTY-NOTICES.txt', 'LEIA-ME.txt')) {
    Remove-Item -LiteralPath (Join-Path $appDirectory $document) -Force -ErrorAction SilentlyContinue
  }
  Write-Host 'O controle local e a inicializacao automatica foram removidos.'
  Write-Host 'Seus projetos e videos no navegador nao foram alterados.'
  if ((Test-Path -LiteralPath $configPath) -and -not $RemovePairing) {
    $answer = Read-Host 'Excluir tambem o pareamento salvo? [s/N]'
    $RemovePairing = $answer -match '^(s|sim)$'
  }
  if ($RemovePairing) { Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue }
  # Keep the small uninstaller scripts so a running Uninstall.cmd is not deleted underneath cmd.exe.
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
