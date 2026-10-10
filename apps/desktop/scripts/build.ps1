param([ValidateSet('debug', 'release')][string]$Profile = 'debug', [switch]$Tests)
$ErrorActionPreference = 'Stop'
$tauri = Join-Path $PSScriptRoot '..\src-tauri'
Push-Location $tauri
try {
    $buildArgs = @('--locked', '--target', 'x86_64-pc-windows-msvc')
    if ($Profile -eq 'release') { $buildArgs += @('--release', '--features', 'custom-protocol') }
    if ($Tests) { & cargo test @buildArgs } else { & cargo build @buildArgs }
    if ($LASTEXITCODE -ne 0) { throw 'Rust build/tests failed' }
} finally { Pop-Location }
