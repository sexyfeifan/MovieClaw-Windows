# MovieClaw Desktop 构建脚本 (Windows)
# 使用 llvm-mingw + Rust GNU 工具链，无需 Visual Studio
#
# 用法:
#   .\scripts\build.ps1          # 构建 debug 版
#   .\scripts\build.ps1 release  # 构建 release 版
param(
    [ValidateSet('debug', 'release')]
    [string]$Profile = 'debug'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 工具链路径
# ---------------------------------------------------------------------------
$LLVM_MINGW = 'C:\Users\zhou_\toolchains\llvm-mingw-20260922-ucrt-x86_64\bin'
$CARGO_BIN = 'C:\Users\zhou_\.cargo\bin'
$SRC_TAURI = Join-Path $PSScriptRoot '..\src-tauri'

if (-not (Test-Path $LLVM_MINGW)) {
    Write-Error "找不到 llvm-mingw: $LLVM_MINGW"
}

# ---------------------------------------------------------------------------
# 环境变量
# ---------------------------------------------------------------------------
$env:PATH = "$LLVM_MINGW;$CARGO_BIN;$env:PATH"
$env:CC_x86_64_pc_windows_gnu = 'clang.exe'
$env:CXX_x86_64_pc_windows_gnu = 'clang++.exe'
$env:AR_x86_64_pc_windows_gnu = 'ar.exe'
$env:AR = 'ar.exe'

# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------
Set-Location $SRC_TAURI

$BuildArgs = @()
if ($Profile -eq 'release') {
    $BuildArgs += '--release'
}

Write-Host "[build] 编译 movieclaw-desktop ($Profile)..." -ForegroundColor Green
& "$CARGO_BIN\cargo.exe" build @BuildArgs 2>&1 | ForEach-Object {
    # 过滤 cargo 的进度行，只显示错误和最终状态
    if ($_ -match '^(error|warning|    Finished|   Compiling movieclaw)') {
        Write-Host $_
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Error "构建失败"
}

$ExePath = Join-Path $SRC_TAURI "target\$Profile\movieclaw-desktop.exe"
if (Test-Path $ExePath) {
    $Size = (Get-Item $ExePath).Length / 1MB
    Write-Host "[build] 构建成功: $ExePath ({0:N1} MB)" -f $Size -ForegroundColor Green
} else {
    Write-Error "找不到输出文件: $ExePath"
}
