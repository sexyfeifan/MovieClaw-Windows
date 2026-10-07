# MovieClaw Desktop 开发启动脚本
# 编译并运行，自动设置 llvm-mingw 环境
#
# 用法:
#   .\scripts\dev.ps1          # 编译 + 运行
#   .\scripts\dev.ps1 build    # 只编译
#   .\scripts\dev.ps1 run      # 只运行（需已编译）
param(
    [ValidateSet('build', 'run', 'all')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'

$LLVM_MINGW = 'C:\Users\zhou_\toolchains\llvm-mingw-20260922-ucrt-x86_64\bin'
$CARGO_BIN = 'C:\Users\zhou_\.cargo\bin'
$SRC_TAURI = Join-Path $PSScriptRoot '..\src-tauri'
$EXE = Join-Path $SRC_TAURI 'target\debug\movieclaw-desktop.exe'

# 设置编译环境
$env:PATH = "$LLVM_MINGW;$CARGO_BIN;$env:PATH"
$env:CC_x86_64_pc_windows_gnu = 'clang.exe'
$env:CXX_x86_64_pc_windows_gnu = 'clang++.exe'
$env:AR_x86_64_pc_windows_gnu = 'ar.exe'
$env:AR = 'ar.exe'

if ($Mode -ne 'run') {
    Write-Host '[dev] 编译中...' -ForegroundColor Green
    Set-Location $SRC_TAURI
    & "$CARGO_BIN\cargo.exe" build 2>&1 | ForEach-Object {
        if ($_ -match '(error|warning.*movieclaw|    Finished)') { Write-Host $_ }
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error '构建失败'
        exit 1
    }
}

if ($Mode -ne 'build') {
    if (-not (Test-Path $EXE)) {
        Write-Error "找不到 exe: $EXE，请先运行 .\scripts\dev.ps1 build"
    }
    Write-Host '[dev] 启动 movieclaw-desktop...' -ForegroundColor Green
    Start-Process -FilePath $EXE
    Write-Host '[dev] 已启动。关闭窗口退出。' -ForegroundColor Yellow
}
