param(
    [Parameter(Mandatory)][string]$PackageDirectory,
    [string]$InstallerPath,
    [switch]$InstallSmoke
)
$ErrorActionPreference = 'Stop'
$package = (Resolve-Path $PackageDirectory).Path
$manifest = Get-Content (Join-Path $PSScriptRoot 'mpv-manifest.json') -Raw | ConvertFrom-Json
$runtime = Join-Path $package 'mpv'
foreach ($file in @('movieclaw-desktop.exe', 'LICENSE', 'mpv\runtime-checksums.json', 'mpv\mpv-manifest.json') + @($manifest.requiredFiles | ForEach-Object { "mpv\$_" }) + @($manifest.licenses | ForEach-Object { "mpv\licenses\$($_.file)" })) {
    if (-not (Test-Path (Join-Path $package $file))) { throw "Package missing: $file" }
}
$inventory = Get-Content (Join-Path $runtime 'runtime-checksums.json') -Raw | ConvertFrom-Json
foreach ($entry in $inventory.PSObject.Properties) {
    $actual = (Get-FileHash (Join-Path $runtime $entry.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.Value) { throw "Runtime checksum mismatch: $($entry.Name)" }
}
$temp = Join-Path ([System.IO.Path]::GetTempPath()) "movieclaw-smoke-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force $temp | Out-Null
$player = $null
$app = $null
$pipe = $null
$oldDataDir = $env:MOVIECLAW_DATA_DIR
$oldWebviewDir = $env:WEBVIEW2_USER_DATA_FOLDER
try {
    $consoleMpv = Join-Path $runtime 'mpv.com'
    $versionOutput = & $consoleMpv --no-config --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch 'mpv ') { throw 'Bundled mpv cannot start' }
    Write-Host $versionOutput.Trim()
    # Real video decoding with deterministic CPU/null output (CI has no HDR display).
    $decoder = Start-Process $consoleMpv -ArgumentList @('--no-config', '--vo=null', '--ao=null', '--frames=5', 'av://lavfi:testsrc=size=64x64:rate=24') -PassThru -NoNewWindow
    if (-not $decoder.WaitForExit(15000)) { $decoder.Kill(); throw 'mpv synthetic video decode timed out' }
    if ($decoder.ExitCode -ne 0) { throw 'mpv synthetic video decode failed' }

    # A finite WAV is seekable and does not require FFmpeg on the runner.
    $wav = Join-Path $temp 'sample.wav'
    $writer = [System.IO.BinaryWriter]::new([System.IO.File]::Create($wav))
    try {
        $samples = 8000 * 5; $dataBytes = $samples * 2
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF')); $writer.Write([int](36 + $dataBytes))
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $writer.Write([int]16)
        $writer.Write([int16]1); $writer.Write([int16]1); $writer.Write([int]8000); $writer.Write([int]16000)
        $writer.Write([int16]2); $writer.Write([int16]16)
        $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data')); $writer.Write([int]$dataBytes)
        $writer.Write([byte[]]::new($dataBytes))
    } finally { $writer.Dispose() }
    $pipeName = "movieclaw-smoke-$([guid]::NewGuid().ToString('N'))"
    $player = Start-Process (Join-Path $runtime 'mpv.exe') -ArgumentList @('--no-config', '--vo=null', '--ao=null', '--pause=yes', '--idle=yes', '--keep-open=yes', "--input-ipc-server=\\.\pipe\$pipeName", $wav) -PassThru
    $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
    $pipe.Connect(5000)
    $inputReader = [System.IO.StreamReader]::new($pipe)
    $outputWriter = [System.IO.StreamWriter]::new($pipe)
    $outputWriter.AutoFlush = $true
    $script:requestNumber = 0
    function Invoke-Mpv([object[]]$Command) {
        $script:requestNumber++
        $id = $script:requestNumber
        $outputWriter.WriteLine((@{ command = $Command; request_id = $id } | ConvertTo-Json -Compress -Depth 5))
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            $read = $inputReader.ReadLineAsync()
            if (-not $read.Wait(3000)) { throw 'mpv IPC response timed out' }
            if (-not $read.Result) { throw 'mpv IPC closed unexpectedly' }
            $reply = $read.Result | ConvertFrom-Json
            if ($reply.request_id -eq $id) {
                if ($reply.error -ne 'success') { throw "mpv IPC failed: $($reply.error)" }
                return $reply.data
            }
        }
        throw 'mpv IPC response missing'
    }
    # loadfile is synchronous at the command level; poll duration for demux completion.
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { $duration = Invoke-Mpv @('get_property', 'duration'); if ($duration -ge 4.9) { $ready = $true; break } } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $ready) { throw 'mpv did not load the synthetic WAV' }
    if ((Invoke-Mpv @('get_property', 'pause')) -ne $true) { throw 'mpv pause state incorrect' }
    $null = Invoke-Mpv @('seek', 1.0, 'absolute+exact')
    $null = Invoke-Mpv @('set_property', 'pause', $false)
    if ((Invoke-Mpv @('get_property', 'pause')) -ne $false) { throw 'mpv IPC unpause failed' }
    Start-Sleep -Milliseconds 150
    if ((Invoke-Mpv @('get_property', 'time-pos')) -lt 0.9) { throw 'mpv seek did not move the playback position' }
    $null = Invoke-Mpv @('stop')
    $outputWriter.WriteLine('{"command":["quit"]}')
    if (-not $player.WaitForExit(5000)) { throw 'mpv did not exit after IPC quit' }
    if ($player.ExitCode -ne 0) { throw 'mpv IPC shutdown failed' }
    $pipe.Dispose(); $pipe = $null

    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MovieClawSmokeWindow {
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
    function Test-NativeApp([string]$Executable) {
        $env:MOVIECLAW_DATA_DIR = Join-Path $temp 'data'
        $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $temp 'webview2'
        $script:app = Start-Process $Executable -PassThru
        $window = [IntPtr]::Zero
        for ($attempt = 0; $attempt -lt 150; $attempt++) {
            $script:app.Refresh()
            if ($script:app.HasExited) { throw "Tauri app exited during startup: $($script:app.ExitCode)" }
            $window = $script:app.MainWindowHandle
            if ($window -ne [IntPtr]::Zero) { break }
            Start-Sleep -Milliseconds 100
        }
        if ($window -eq [IntPtr]::Zero) { throw 'Tauri main window was not created' }
        $webviewFound = $false
        for ($attempt = 0; $attempt -lt 50; $attempt++) {
            $children = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.ParentProcessId -eq $script:app.Id })
            if ($children.Count -gt 0) { $webviewFound = $true; break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $webviewFound) { throw 'WebView2 browser process did not start' }
        $null = [MovieClawSmokeWindow]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        if (-not $script:app.WaitForExit(5000)) { throw 'Tauri shutdown exceeded its bounded cleanup window' }
        if ($script:app.ExitCode -ne 0) { throw 'Tauri shutdown failed' }
        $script:app = $null
    }
    Test-NativeApp (Join-Path $package 'movieclaw-desktop.exe')
    if ($InstallSmoke) {
        if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) { throw 'Install smoke requires the built NSIS installer' }
        $installed = Join-Path $temp 'installed'
        $setup = Start-Process $InstallerPath -ArgumentList @('/S', "/D=$installed") -PassThru
        if (-not $setup.WaitForExit(120000)) { $setup.Kill(); throw 'NSIS installation timed out' }
        if ($setup.ExitCode -ne 0) { throw 'NSIS installation failed' }
        foreach ($file in @('movieclaw-desktop.exe', 'mpv\mpv.exe', 'mpv\d3dcompiler_43.dll', 'mpv\licenses\MPV-GPL.txt')) {
            if (-not (Test-Path (Join-Path $installed $file))) { throw "Installer missing runtime resource: $file" }
        }
        Test-NativeApp (Join-Path $installed 'movieclaw-desktop.exe')
        $uninstaller = Join-Path $installed 'uninstall.exe'
        if (Test-Path $uninstaller) {
            $remove = Start-Process $uninstaller -ArgumentList '/S' -PassThru
            if (-not $remove.WaitForExit(30000)) { $remove.Kill(); throw 'NSIS uninstall timed out' }
            if ($remove.ExitCode -ne 0) { throw 'NSIS uninstall failed' }
        }
    }
    Write-Host 'PASS: package integrity, mpv synthetic decode/IPC, native WebView2 startup and bounded shutdown'
} finally {
    if ($pipe) { $pipe.Dispose() }
    if ($player -and -not $player.HasExited) { $player.Kill() }
    if ($script:app -and -not $script:app.HasExited) { $script:app.Kill() }
    $env:MOVIECLAW_DATA_DIR = $oldDataDir
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldWebviewDir
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
}
