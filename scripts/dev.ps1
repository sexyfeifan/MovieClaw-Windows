# MovieClaw local dev launcher (Windows)
# Usage:
#   .\scripts\dev.ps1          # start both API + Web
#   .\scripts\dev.ps1 api      # API only
#   .\scripts\dev.ps1 web      # Web only
param(
    [Parameter(Position = 0)]
    [ValidateSet('all', 'api', 'web')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root 'pyproject.toml'))) {
    $Root = $PSScriptRoot
    if (-not (Test-Path (Join-Path $Root 'pyproject.toml'))) {
        Write-Error 'pyproject.toml not found; run from repo root'
    }
}
Set-Location $Root

function Write-Info([string]$Message) { Write-Host "[dev] $Message" -ForegroundColor Green }
function Write-Fail([string]$Message) {
    Write-Host "[dev] ERROR: $Message" -ForegroundColor Red
    exit 1
}

function Find-Python {
    $candidates = @()
    foreach ($cmd in @('py', 'python3', 'python')) {
        $found = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($found) { $candidates += $found.Source }
    }
    $candidates += @(
        "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        'C:\Python314\python.exe', 'C:\Python313\python.exe',
        'C:\Python312\python.exe', 'C:\Python311\python.exe'
    )
    foreach ($exe in $candidates) {
        if (-not $exe) { continue }
        if ($exe -match '\\py(\.exe)?$') {
            foreach ($ver in @('3.14', '3.13', '3.12', '3.11')) {
                & $exe "-$ver" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
                if ($LASTEXITCODE -eq 0) { return @{ Launcher = $exe; Arg = "-$ver" } }
            }
            continue
        }
        if (Test-Path $exe) {
            & $exe -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
            if ($LASTEXITCODE -eq 0) { return @{ Launcher = $exe; Arg = $null } }
        }
    }
    return $null
}

function Prepare-EnvFile {
    if (-not (Test-Path '.env')) {
        Copy-Item '.env.example' '.env'
        Write-Info '.env created from .env.example'
    }
}

function Invoke-Python {
    param([string[]]$PyArgs)
    if ($script:PythonInfo.Arg) {
        & $script:PythonInfo.Launcher $script:PythonInfo.Arg @PyArgs
    } else {
        & $script:PythonInfo.Launcher @PyArgs
    }
    if ($LASTEXITCODE -ne 0) { Write-Fail "python $($PyArgs -join ' ') failed" }
}

function Prepare-Python {
    $venvPython = Join-Path $Root '.venv\Scripts\python.exe'
    if (Test-Path $venvPython) {
        & $venvPython -c 'import sys; sys.exit(0)' 2>$null
        if ($LASTEXITCODE -eq 0) { $script:VenvPython = $venvPython; return }
        Write-Info 'venv broken, recreating...'
        Remove-Item -Recurse -Force '.venv'
    } else {
        Write-Info 'creating .venv ...'
    }

    $script:PythonInfo = Find-Python
    if (-not $script:PythonInfo) {
        Write-Fail 'Python 3.11+ not found; install with: winget install Python.Python.3.12'
    }
    $verText = if ($script:PythonInfo.Arg) { & $script:PythonInfo.Launcher $script:PythonInfo.Arg --version } else { & $script:PythonInfo.Launcher --version }
    Write-Info "using $($verText -join '') to create venv"
    Invoke-Python @('-m', 'venv', '.venv')

    Write-Info 'installing backend deps (pip install -e .[dev])...'
    & $venvPython -m pip install --quiet -e '.[dev]'
    if ($LASTEXITCODE -ne 0) {
        Write-Fail 'pip install failed; try mirror: pip install -e .[dev] -i https://pypi.tuna.tsinghua.edu.cn/simple'
    }
    Write-Info 'backend env ready'
    $script:VenvPython = $venvPython
}

function Find-Pnpm {
    $found = Get-Command 'pnpm' -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $userPnpm = Join-Path $env:APPDATA 'npm\pnpm.cmd'
    if (Test-Path $userPnpm) { return $userPnpm }
    $corepack = Get-Command 'corepack' -ErrorAction SilentlyContinue
    if ($corepack) { return 'corepack pnpm' }
    return $null
}

function Prepare-Node {
    $script:PnpmCmd = Find-Pnpm
    if (-not $script:PnpmCmd) {
        Write-Fail 'pnpm not found; install with: npm install -g pnpm'
    }
    if (-not (Test-Path 'apps\web\node_modules')) {
        Write-Info 'installing frontend deps (pnpm install)...'
        if ($script:PnpmCmd -eq 'corepack pnpm') { & corepack pnpm install } else { & $script:PnpmCmd install }
        if ($LASTEXITCODE -ne 0) { Write-Fail 'pnpm install failed' }
    }
}

function Read-ApiPort {
    if (Test-Path '.env') {
        $line = Select-String -Path '.env' -Pattern '^\s*APP_PORT\s*=' | Select-Object -Last 1
        if ($line) {
            $port = ($line.Line -split '=', 2)[1].Trim().Trim('"').Trim("'")
            if ($port -match '^\d+$') { return [int]$port }
        }
    }
    return 8000
}

function Assert-PortFree([int]$Port, [string]$Name) {
    $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($inUse) {
        $pids = ($inUse | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
        Write-Fail "port $Port in use ($Name). PIDs: $pids"
    }
}

$script:Children = @()

function Start-PrefixedProcess {
    param(
        [string]$Tag,
        [string]$Color,
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($ArgumentList | ForEach-Object {
            if ($_ -match '[\s"]') { '"{0}"' -f ($_ -replace '"', '\"') } else { $_ }
        }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $sync = [hashtable]::Synchronized(@{ Color = $Color })

    $null = $proc.add_OutputDataReceived({
            param($sender, $e)
            if (-not [string]::IsNullOrEmpty($e.Data)) {
                [System.Threading.Monitor]::Enter($sync)
                try {
                    Write-Host "[$Tag] $($e.Data)" -ForegroundColor $Color
                } finally {
                    [System.Threading.Monitor]::Exit($sync)
                }
            }
        }.GetNewClosure())
    $null = $proc.add_ErrorDataReceived({
            param($sender, $e)
            if (-not [string]::IsNullOrEmpty($e.Data)) {
                [System.Threading.Monitor]::Enter($sync)
                try {
                    Write-Host "[$Tag] $($e.Data)" -ForegroundColor $Color
                } finally {
                    [System.Threading.Monitor]::Exit($sync)
                }
            }
        }.GetNewClosure())

    $null = $proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    $script:Children += $proc
    return $proc
}

function Stop-AllChildren {
    foreach ($proc in $script:Children) {
        if ($proc.HasExited) { continue }
        try {
            if ($env:ComSpec) {
                Start-Process -FilePath 'taskkill' -ArgumentList '/PID', $proc.Id, '/T', '/F' -WindowStyle Hidden -Wait
            } else {
                $proc.Kill($true)
            }
        } catch {
            Write-Host "[dev] failed to stop child $($proc.Id): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

try {
    Prepare-EnvFile
    $ApiPort = Read-ApiPort

    if ($Mode -ne 'web') { Prepare-Python }
    if ($Mode -ne 'api') { Prepare-Node }

    if ($Mode -ne 'web') { Assert-PortFree $ApiPort 'api' }
    if ($Mode -ne 'api') { Assert-PortFree 3000 'web' }

    if ($Mode -ne 'web') {
        Write-Info "starting FastAPI (port $ApiPort, auto-reload)..."
        $apiExe = Join-Path $Root '.venv\Scripts\movieclaw-api.exe'
        if (-not (Test-Path $apiExe)) { $apiExe = $script:VenvPython }
        $apiArgs = if ($apiExe -like '*movieclaw-api.exe') { @() } else { @('-m', 'movieclaw_api.main') }
        Start-PrefixedProcess -Tag 'api' -Color 'Cyan' -FilePath $apiExe -ArgumentList $apiArgs -WorkingDirectory $Root | Out-Null

        Start-Job -ScriptBlock {
            param($Port, $Root)
            for ($i = 0; $i -lt 60; $i++) {
                try {
                    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/v1/health" -UseBasicParsing -TimeoutSec 2
                    if ($r.StatusCode -eq 200) {
                        Write-Output 'api ready'
                        Write-Output "  API docs:  http://127.0.0.1:$Port/docs"
                        Write-Output "  health:    http://127.0.0.1:$Port/api/v1/health"
                        return
                    }
                } catch { }
                Start-Sleep -Milliseconds 500
            }
            Write-Output 'api not ready in 30s, check [api] logs above'
        } -ArgumentList $ApiPort, $Root | Receive-Job -Wait -AutoRemoveJob | ForEach-Object {
            Write-Info $_
        }
        if ($Mode -eq 'all') {
            Write-Info '  Web console: http://127.0.0.1:3000'
            Write-Host ''
        }
    }

    if ($Mode -ne 'api') {
        Write-Info 'starting Next.js (port 3000)...'
        if ($script:PnpmCmd -eq 'corepack pnpm') {
            Start-PrefixedProcess -Tag 'web' -Color 'Magenta' -FilePath 'corepack' -ArgumentList @('pnpm', 'web:dev') -WorkingDirectory $Root | Out-Null
        } else {
            Start-PrefixedProcess -Tag 'web' -Color 'Magenta' -FilePath $script:PnpmCmd -ArgumentList @('web:dev') -WorkingDirectory $Root | Out-Null
        }
    }

    Write-Info 'all services started; press Ctrl-C to stop'
    while ($true) {
        Start-Sleep -Seconds 1
        $alive = $script:Children | Where-Object { -not $_.HasExited }
        if (-not $alive) {
            Write-Fail 'all child processes exited, check logs above'
        }
    }
}
finally {
    Write-Host ''
    Write-Info 'stopping all services...'
    Stop-AllChildren
}
