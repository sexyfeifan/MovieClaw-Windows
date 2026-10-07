# Create GitHub Release for MovieClaw Desktop
$ErrorActionPreference = "Stop"

# Get token from git credentials
$credInput = "protocol=https`nhost=github.com`n`n"
$cred = $credInput | git credential fill 2>$null | Out-String
$token = ($cred -split "`n" | Where-Object { $_ -match '^password=' }) -replace '^password=',''
Write-Host "Token length: $($token.Length)"

$headers = @{
    "Authorization" = "Bearer $token"
    "Accept" = "application/vnd.github.v3+json"
}

$releaseBody = @"
## MovieClaw Desktop v0.1.0

首个 Windows 桌面客户端正式版本。

### 新功能
- Tauri 2 + WebView2 + mpv 混合架构
- 浏览器内拦截播放路由, mpv 本地硬解播放
- 音量控制: 浮动控件 + 快捷键 (ArrowUp/ArrowDown/M)
- 进度同步: start/progress/stop 事件上报
- 自动更新: 启动检查 + 托盘手动检查
- 单实例 + 系统托盘
- 服务器连接管理 (更改服务器/重新连接)

### 安装
- **Setup-x64.exe** - NSIS 安装包 (推荐)
- **portable-x64.zip** - 便携版 (解压即用)

### 系统要求
- Windows 10/11 x64
- WebView2 Runtime
- mpv
"@

$body = @{
    tag_name = "desktop-v0.1.0"
    name = "MovieClaw Desktop v0.1.0"
    body = $releaseBody
    draft = $false
    prerelease = $false
} | ConvertTo-Json

$proxy = "http://192.168.101.2:7890"

# Create release
$uri = "https://api.github.com/repos/sexyfeifan/MovieClaw-Windows/releases"
Write-Host "Creating release..."
$release = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body $body -Proxy $proxy -ContentType "application/json"
Write-Host "Release created! ID: $($release.id)"
Write-Host "URL: $($release.html_url)"

# Upload assets
$uploadBase = $release.upload_url -replace '\{.*\}', ''

$assets = @(
    @{ path = "apps/desktop/dist/MovieClaw-Desktop-0.1.0-Setup-x64.exe"; name = "MovieClaw-Desktop-0.1.0-Setup-x64.exe"; type = "application/octet-stream" },
    @{ path = "apps/desktop/dist/MovieClaw-Desktop-portable-x64.zip"; name = "MovieClaw-Desktop-portable-x64.zip"; type = "application/zip" }
)

foreach ($asset in $assets) {
    $filePath = Join-Path "C:\VibeCoding\MovieClaw-Windows\MovieClaw" $asset.path
    if (Test-Path $filePath) {
        $fileSize = (Get-Item $filePath).Length
        Write-Host "Uploading $($asset.name) ($([math]::Round($fileSize/1MB, 1)) MB)..."

        $uploadUri = "${uploadBase}?name=$($asset.name)"
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $response = Invoke-RestMethod -Uri $uploadUri -Method Post -Headers $headers -Body $bytes -Proxy $proxy -ContentType $asset.type
        Write-Host "  Uploaded! ID: $($response.id)"
    } else {
        Write-Host "  SKIP: $filePath not found"
    }
}

Write-Host "`nDone! Release URL: $($release.html_url)"
