# Mantém o backend da Bilheteria SEMPRE ativo (Windows).
#
# O agendador de fichas corre dentro do servidor: fichas do dia à meia-noite de
# Angola, reposição de estoque e expiração. Este script garante apenas que o
# processo é reiniciado automaticamente se cair.
#
# Uso:  npm run start:always
#   ou: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-always.ps1

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[start-always] Raiz: $root"

while ($true) {
  $startedAt = Get-Date
  Write-Host "[start-always] A iniciar servidor ($startedAt)..."

  try {
    npm start
  } catch {
    Write-Host "[start-always] O servidor terminou com erro: $_"
  }

  $uptime = (Get-Date) - $startedAt
  if ($uptime.TotalSeconds -lt 15) {
    Write-Host "[start-always] Saída rápida detetada. A aguardar 10s antes de reiniciar..."
    Start-Sleep -Seconds 10
  } else {
    Write-Host "[start-always] Servidor parou após $([int]$uptime.TotalSeconds)s. A reiniciar em 3s..."
    Start-Sleep -Seconds 3
  }
}
