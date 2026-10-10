param([string]$Destination = (Join-Path $PSScriptRoot '..\dist\runtime\mpv'))
$ErrorActionPreference = 'Stop'
$manifestPath = Join-Path $PSScriptRoot 'mpv-manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$cache = Join-Path $PSScriptRoot '..\dist\downloads'
New-Item -ItemType Directory -Force $cache | Out-Null
$archive = Join-Path $cache "$($manifest.version).7z"
if (-not (Test-Path $archive)) {
    Invoke-WebRequest -Uri $manifest.url -OutFile $archive -TimeoutSec 120
}
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256) {
    Remove-Item $archive -Force
    throw 'mpv archive checksum mismatch; refusing to package it'
}
$sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
if (-not $sevenZip) { $sevenZip = Get-Item 'C:\Program Files\7-Zip\7z.exe' -ErrorAction SilentlyContinue }
if (-not $sevenZip) { throw '7-Zip is required to extract the pinned mpv runtime' }
$sevenZipPath = if ($sevenZip.Source) { $sevenZip.Source } else { $sevenZip.FullName }
if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
New-Item -ItemType Directory -Force $Destination | Out-Null
& $sevenZipPath x $archive "-o$Destination" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'mpv extraction failed' }
foreach ($file in $manifest.requiredFiles) {
    if (-not (Test-Path (Join-Path $Destination $file))) { throw "Missing mpv runtime dependency: $file" }
}
# Keep the pinned runtime immutable; do not ship the upstream auto-updater.
foreach ($file in @('updater.bat', 'installer\updater.ps1')) {
    Remove-Item (Join-Path $Destination $file) -ErrorAction SilentlyContinue
}
$licenseDir = Join-Path $Destination 'licenses'
New-Item -ItemType Directory -Force $licenseDir | Out-Null
foreach ($license in $manifest.licenses) {
    $source = Join-Path $PSScriptRoot "licenses\$($license.file)"
    if ((Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $license.sha256) {
        throw "License checksum mismatch: $($license.file)"
    }
    Copy-Item $source $licenseDir
}
Copy-Item $manifestPath (Join-Path $Destination 'mpv-manifest.json')
$checksums = @{}
Get-ChildItem $Destination -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring((Get-Item $Destination).FullName.Length + 1).Replace('\', '/')
    $checksums[$relative] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$checksums | ConvertTo-Json | Set-Content (Join-Path $Destination 'runtime-checksums.json') -Encoding utf8
Write-Host "Prepared verified mpv $($manifest.version)"
