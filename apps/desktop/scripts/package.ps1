param([switch]$SkipBuild, [switch]$InstallSmoke)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauri = Join-Path $root 'src-tauri'
$dist = Join-Path $root 'dist'
$cargo = Get-Content (Join-Path $tauri 'Cargo.toml') -Raw
if ($cargo -notmatch '(?m)^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"') { throw 'Missing Cargo package version' }
$version = $Matches[1]
& (Join-Path $PSScriptRoot 'prepare-runtime.ps1')
# The only version source is Cargo.toml. Tauri reads it when config.version is omitted.
# The additional bundle config is generated after the verified runtime exists.
$configPath = Join-Path $dist 'tauri.bundle.conf.json'
$resources = @{}
$resources[(Join-Path $dist 'runtime\mpv').Replace('\', '/') + '/'] = 'mpv/'
@{ bundle = @{ resources = $resources } } | ConvertTo-Json -Depth 5 | Set-Content $configPath -Encoding utf8
if (-not $SkipBuild) {
    # A cached/local target may contain an installer for an older Cargo version.
    $nsisOutput = Join-Path $tauri 'target\x86_64-pc-windows-msvc\release\bundle\nsis'
    if (Test-Path $nsisOutput) { Remove-Item $nsisOutput -Recurse -Force }
    Push-Location $root
    try {
        & npm exec -- tauri build --target x86_64-pc-windows-msvc --bundles nsis --ci --config $configPath -- --locked
        if ($LASTEXITCODE -ne 0) { throw 'Tauri release/package build failed' }
    } finally { Pop-Location }
}
$target = Join-Path $tauri 'target\x86_64-pc-windows-msvc\release'
$exe = Join-Path $target 'movieclaw-desktop.exe'
$installer = @(Get-ChildItem (Join-Path $target 'bundle\nsis') -Filter '*.exe' -ErrorAction Stop)
if (-not (Test-Path $exe) -or $installer.Count -ne 1) { throw 'Expected one executable and exactly one NSIS installer' }
$portable = Join-Path $dist 'portable'
if (Test-Path $portable) { Remove-Item $portable -Recurse -Force }
New-Item -ItemType Directory -Force $portable | Out-Null
Copy-Item $exe $portable
Copy-Item (Join-Path $dist 'runtime\mpv') $portable -Recurse
Copy-Item (Join-Path $root '..\..\LICENSE') $portable
@"
MovieClaw Desktop $version (Windows x64)
Run movieclaw-desktop.exe. UI assets are embedded in the executable.
mpv and its runtime dependencies/licenses are included in mpv/.
The portable package requires Microsoft WebView2 Evergreen Runtime.
The installer offers to install WebView2 when it is missing.
"@ | Set-Content (Join-Path $portable 'README.txt') -Encoding utf8
$setupName = "MovieClaw-Desktop-$version-Setup-x64.exe"
$zipName = "MovieClaw-Desktop-$version-portable-x64.zip"
Copy-Item $installer[0].FullName (Join-Path $dist $setupName) -Force
Compress-Archive -Path "$portable\*" -DestinationPath (Join-Path $dist $zipName) -Force
$hashes = @($setupName, $zipName) | ForEach-Object {
    "$((Get-FileHash (Join-Path $dist $_) -Algorithm SHA256).Hash.ToLowerInvariant())  $_"
}
$hashes | Set-Content (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
& (Join-Path $PSScriptRoot 'smoke.ps1') -PackageDirectory $portable -InstallerPath (Join-Path $dist $setupName) -InstallSmoke:$InstallSmoke
if ($LASTEXITCODE -ne 0) { throw 'Package smoke test failed' }
Write-Host "Verified packages for MovieClaw Desktop $version are in $dist"
