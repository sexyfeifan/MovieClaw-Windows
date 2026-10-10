# MovieClaw Desktop for Windows

Windows x64 client with a Tauri/WebView2 interface and bundled mpv playback. The UI is embedded in the executable. The server remains a separate MovieClaw deployment.

## Build and test

Install PowerShell 7, Node.js 22, Rust stable for `x86_64-pc-windows-msvc`, Visual Studio Build Tools (Desktop development with C++), and 7-Zip. Windows builds have no developer-specific paths or GNU/MinGW dependency.

```powershell
cd apps/desktop
npm ci
.\scripts\build.ps1 -Tests
npm run test:unit
npx playwright install chromium
npm run test:e2e
.\scripts\dev.ps1
```

Tests use isolated temporary data. `MOVIECLAW_DATA_DIR` overrides the normal `%APPDATA%\movieclaw-desktop` folder for native smoke tests. `MOVIECLAW_MPV` can override the player path during development; distribution uses the verified bundled runtime.

## Packaging

```powershell
.\scripts\package.ps1
```

`package.ps1` is used locally and by both GitHub Actions workflows. It verifies and extracts the exact mpv archive recorded in `scripts/mpv-manifest.json`, includes its DLLs, source metadata and license notices, invokes the pinned Tauri CLI for an NSIS installer, and assembles the portable ZIP from the same executable/runtime. Required files, checksums, process startup and mpv IPC are checked before artifacts are accepted. CI also checks silent installation, installed-app startup and uninstallation; run `package.ps1 -InstallSmoke` to opt into that locally. `Cargo.toml` is the only application version source. The installer downloads Microsoft WebView2 Evergreen Runtime if it is missing; portable users must install the runtime themselves.

Desktop CI runs on Windows MSVC for branch pushes and PRs. Desktop releases only run for `desktop-vX.Y.Z` tags matching Cargo, and reuse the same test/build/package workflow before publishing artifacts. Existing unrelated server release workflows are separate.

Browser E2E covers the real DOM and HTTP contracts with a native bridge fixture. Native smoke covers the packaged executable, WebView2 process startup, bundled mpv decoding and IPC. HDR/Dolby output, embedded video geometry, GPU hardware decode, multi-monitor DPI and picture quality still require a Windows machine with the relevant hardware.

CI uploads `smoke-environment.json` with Windows/CPU/GPU driver details, tool and runtime versions, and portable/installed startup and shutdown durations. These numbers describe the hosted runner's smoke test, and are not a real-machine playback performance baseline.

## Authentication and shutdown

Cookie credentials are isolated by complete server origin, including port, and never attached to external media origins or redirected external requests. The older global `cookies.json` cannot be assigned safely to a server and is removed on migration; upgrading requires signing in again once. Native device tokens and Windows Credential Manager remain a later parity stage.

Window close and tray Quit share a shutdown hook: the player has up to 1.5 seconds to flush progress and release sessions, after which Rust terminates the player and exits. Changing servers cancels old network requests before the new context is used.
