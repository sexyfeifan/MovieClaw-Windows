# MovieClaw Desktop — Windows 打包脚本
# 用法: powershell -ExecutionPolicy Bypass -File package.ps1 [-SkipBuild]
#
# 产出:
#   dist/MovieClaw-Desktop-{version}-portable-x64.zip  (便携版)
#   dist/MovieClaw-Desktop-{version}-Setup-x64.exe     (NSIS 安装包)
#   dist/mpv/                                          (mpv sidecar + checksum)

param(
    [switch]$SkipBuild,
    [string]$MpvDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent          # apps/desktop
$TauriDir = Join-Path $Root "src-tauri"
$UiDir = Join-Path $Root "ui"
$Dist = Join-Path $Root "dist"
$Version = "0.1.0"

# 读取 Cargo.toml 中的版本号
$cargoToml = Get-Content (Join-Path $TauriDir "Cargo.toml") -Raw
if ($cargoToml -match 'version\s*=\s*"([^"]+)"') { $Version = $Matches[1] }

Write-Host "=== MovieClaw Desktop v$Version 打包 ===" -ForegroundColor Cyan

# ---- 1. 构建 release ----
if (-not $SkipBuild) {
    Write-Host "`n[1/4] 构建 release ..." -ForegroundColor Yellow
    $env:PATH = "C:\Users\zhou_\toolchains\llvm-mingw-20260922-ucrt-x86_64\bin;C:\Users\zhou_\.cargo\bin;$env:PATH"
    $env:CC_x86_64_pc_windows_gnu = "C:\Users\zhou_\toolchains\llvm-mingw-20260922-ucrt-x86_64\bin\clang.exe"
    $env:CXX_x86_64_pc_windows_gnu = "C:\Users\zhou_\toolchains\llvm-mingw-20260922-ucrt-x86_64\bin\clang++.exe"
    $env:AR_x86_64_pc_windows_gnu = "C:\Users\zhou_\toolchains\llvm-mingw-20260922-ucrt-x86_64\bin\ar.exe"

    Push-Location $TauriDir
    & "C:\Users\zhou_\.cargo\bin\cargo.exe" build --release 2>&1 | Tee-Object -Variable buildLog
    if ($LASTEXITCODE -ne 0) {
        Write-Host "构建失败!" -ForegroundColor Red
        Pop-Location
        exit 1
    }
    Pop-Location
} else {
    Write-Host "`n[1/4] 跳过构建 (使用已有 release)" -ForegroundColor Yellow
}

$ExePath = Join-Path $TauriDir "target\release\movieclaw-desktop.exe"
if (-not (Test-Path $ExePath)) {
    Write-Host "找不到 $ExePath" -ForegroundColor Red
    exit 1
}

# ---- 2. 准备 mpv sidecar ----
Write-Host "`n[2/4] 准备 mpv sidecar ..." -ForegroundColor Yellow
$MpvDist = Join-Path $Dist "mpv"
New-Item -ItemType Directory -Force -Path $MpvDist | Out-Null

if ($MpvDir -and (Test-Path $MpvDir)) {
    Copy-Item "$MpvDir\*" $MpvDist -Recurse -Force
    Write-Host "  从 $MpvDir 复制 mpv"
} else {
    # 尝试从 PATH 或已知位置找 mpv
    $mpvExe = Get-Command "mpv.exe" -ErrorAction SilentlyContinue
    if ($mpvExe) {
        Copy-Item $mpvExe.Source $MpvDist
        Write-Host "  从 PATH 复制 mpv: $($mpvExe.Source)"
    } elseif (Test-Path "C:\tools\mpv\mpv.exe") {
        Copy-Item "C:\tools\mpv\mpv.exe" $MpvDist
        Write-Host "  从 C:\tools\mpv 复制 mpv"
    } else {
        Write-Host "  警告: 未找到 mpv.exe，跳过 sidecar" -ForegroundColor Yellow
        Write-Host "  提示: 用 -MpvDir <path> 指定 mpv 目录"
    }
}

# 生成 mpv checksum
$mpvExePath = Join-Path $MpvDist "mpv.exe"
if (Test-Path $mpvExePath) {
    $hash = (Get-FileHash $mpvExePath -Algorithm SHA256).Hash
    $mpvVer = ""
    try {
        $vi = (Get-Item $mpvExePath).VersionInfo
        $mpvVer = "$($vi.FileMajorPart).$($vi.FileMinorPart).$($vi.FileBuildPart)"
    } catch {}
    $checksumData = @{
        file    = "mpv.exe"
        version = $mpvVer
        sha256  = $hash
        size    = (Get-Item $mpvExePath).Length
    }
    $checksumData | ConvertTo-Json | Set-Content (Join-Path $MpvDist "mpv-checksum.json")
    Write-Host "  mpv SHA256: $($hash.Substring(0,16))..."
}

# ---- 3. 组装便携版 ----
Write-Host "`n[3/4] 组装便携版 ..." -ForegroundColor Yellow
$PortableDir = Join-Path $Dist "portable"
if (Test-Path $PortableDir) { Remove-Item $PortableDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $PortableDir | Out-Null

# 主程序
Copy-Item $ExePath $PortableDir
# UI 文件
Copy-Item (Join-Path $UiDir "connect.html") $PortableDir
Copy-Item (Join-Path $UiDir "inject.js") $PortableDir
# mpv sidecar
if (Test-Path $MpvDist) {
    New-Item -ItemType Directory -Force -Path (Join-Path $PortableDir "mpv") | Out-Null
    Copy-Item "$MpvDist\*" (Join-Path $PortableDir "mpv") -Recurse -Force
}

# 便携版说明
@"
MovieClaw Desktop v$Version (Portable)

使用方法:
1. 首次运行 movieclaw-desktop.exe
2. 在连接界面输入 MovieClaw 服务器地址
3. 浏览媒体库并播放

系统要求:
- Windows 10/11 x64
- WebView2 Runtime (Win11 自带)
- mpv (已附带于 mpv/ 目录)

文件说明:
- movieclaw-desktop.exe  主程序
- mpv/                   mpv 播放器
- connect.html           连接页面
- inject.js              播放桥接脚本
"@ | Set-Content (Join-Path $PortableDir "README.txt")

# 打 zip
$ZipName = "MovieClaw-Desktop-$Version-portable-x64.zip"
$ZipPath = Join-Path $Dist $ZipName
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path "$PortableDir\*" -DestinationPath $ZipPath
$zipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host "  $ZipName ($zipSize MB)" -ForegroundColor Green

# ---- 4. 构建 NSIS 安装包 ----
Write-Host "`n[4/4] 构建 NSIS 安装包 ..." -ForegroundColor Yellow

# 尝试用 Tauri bundler
$tauriCli = Join-Path $env:USERPROFILE ".cargo\bin\cargo-tauri.exe"
if (Test-Path $tauriCli) {
    Push-Location $TauriDir
    & $tauriCli bundle --bundles nsis 2>&1 | Tee-Object -Variable bundleLog
    Pop-Location
    # Tauri 的 NSIS 输出
    $nsisOutput = Join-Path $TauriDir "target\release\bundle\nsis\*.exe"
    $nsisFile = Get-Item $nsisOutput -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nsisFile) {
        Copy-Item $nsisFile.FullName $Dist
        Write-Host "  $($nsisFile.Name)" -ForegroundColor Green
    }
} else {
    Write-Host "  cargo-tauri 不可用，跳过 NSIS" -ForegroundColor Yellow
    Write-Host "  便携版 zip 已生成，可直接分发"
}

# ---- 汇总 ----
Write-Host "`n=== 打包完成 ===" -ForegroundColor Cyan
Write-Host "输出目录: $Dist" -ForegroundColor White
Get-ChildItem $Dist -File | ForEach-Object {
    $size = if ($_.Length -gt 1MB) { "$([math]::Round($_.Length/1MB,1)) MB" } else { "$([math]::Round($_.Length/1KB,1)) KB" }
    Write-Host "  $($_.Name)  ($size)"
}
