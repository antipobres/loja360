param([Parameter(Mandatory=$true)][string]$ZipPath, [Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $PSScriptRoot "releases"
New-Item -ItemType Directory -Force $release | Out-Null
$zip = Join-Path $release ("Dashboard-Windows-" + $Version + ".zip")
Copy-Item -LiteralPath $ZipPath -Destination $zip -Force
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$base = "https://seu-dominio.example/releases/" + [IO.Path]::GetFileName($zip)
@{ version=$Version; packageUrl=$base; sha256=$hash; notes="Atualizacao publicada em $(Get-Date -Format s)" } |
    ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot "manifest.json") -Encoding UTF8
Write-Host "Publicado: $zip"
Write-Host "Hospede esta pasta como site estatico e ajuste packageUrl/manifestUrl."
