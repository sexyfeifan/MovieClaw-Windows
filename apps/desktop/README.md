# MovieClaw Desktop for Windows

Windows x64 client with a Tauri/WebView2 interface and bundled mpv playback. The UI is embedded in the executable. The server remains a separate MovieClaw deployment.

## Build and test

Install PowerShell 7, Node.js 22.23.3, Python 3.12.9 (release-gate tests), Rust 1.99.0 for `x86_64-pc-windows-msvc`, Visual Studio Build Tools (Desktop development with C++), and 7-Zip. CI pins these tool versions and records the hosted Windows image/runtime environment. Windows builds have no developer-specific paths or GNU/MinGW dependency.

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

The pinned mpv imports `vulkan-1.dll` at process startup, including CPU playback and `--version`. Packaging includes the x64 Vulkan loader from the official LunarG runtime components ZIP with its published archive hash, binary hash, MIT notices and Apache license; it does not rely on a GPU driver having installed the loader globally. No Windows system DLLs are copied into the package.

Desktop CI runs on Windows MSVC for branch pushes and PRs. It uploads verified installer/portable packages, `SHA256SUMS.txt`, and `release-manifest.json`. The manifest records the exact revision, runtime sources/licenses, package hashes and actual Authenticode status. An unsigned build is reported as unsigned.

Stable releases only run for `desktop-vX.Y.Z` tags matching Cargo. Publication additionally requires repository variables `DESKTOP_ACCEPTANCE_RUN_ID` (successful Desktop CI for the exact commit) and `DESKTOP_HARDWARE_ACCEPTANCE_JSON` (the completed `release/acceptance.example.json` contract). The gate checks exact physically tested artifact hashes, real valid application/installer signatures, and Windows/macOS hardware acceptance. It reuses those tested artifacts instead of substituting a rebuild. Without physical evidence or a signing certificate, CI artifacts remain available and stable publication is blocked. Existing server release workflows are separate.

Browser E2E covers the real DOM and HTTP contracts with a native bridge fixture. Native smoke covers the packaged executable, WebView2 process startup, bundled mpv decoding and IPC. HDR/Dolby output, embedded video geometry, GPU hardware decode, multi-monitor DPI and picture quality still require a Windows machine with the relevant hardware.

CI uploads `smoke-environment.json` with Windows/CPU/GPU driver details, tool and runtime versions, and portable/installed startup and shutdown durations. Startup ends at a real native bridge acknowledgment; window creation is a separate measurement. The platform probe covers native lifecycle, window restoration, power-request cleanup, and reports actual SMTC availability on the VM.

Performance artifacts remain separate: `browser-performance.json` measures the Chromium fixture's page/player cycles; `native-performance.json` records 60 seconds of Tauri/WebView2 process-tree idle resources, 20 real standalone bundled-mpv launch/seek/pause/quit cycles, and software decoding of generated 1080p H.264/4K HEVC fixtures. It records the source revision, mpv executable hash and encoder inventory, plus short AV1/VP9/HEVC Main10 compatibility fixtures when their encoders are available. Main10 requires actual 4:2:0 10-bit decoded pixels; unavailable encoders or formats are recorded as unsupported. Decoder readiness is distinct from the first frame presented on a display. These hosted-VM measurements do not establish physical GPU/HDR/audio performance or Windows/macOS equivalence.

## Authentication and shutdown

Servers advertising `windows` in `/auth/bootstrap.native_device_kinds` use Windows device login and QR pairing. Device tokens and installation IDs stay in the current Windows user's Credential Manager; JavaScript receives account/session labels and opaque pairing handles. Older servers use compatible cookie authentication. Cookie files migrate to Windows-user DPAPI encryption; cookie origin, port, path, expiry and Secure flags are checked at every redirect. Device mode never falls back to an old cookie bag after logout. The older unscoped `cookies.json` is removed on migration, requiring one sign-in. Account/vault/cookie namespaces use the complete normalized server base URL: deployments at `/a` and `/b` on the same host remain separate, and redirect credentials require an origin plus path-boundary match. Legacy origin-only jars are usable only at the root deployment; prefixed deployments require sign-in again.

Server URL, account identity and generation are captured/committed atomically. Changing servers cancels old requests and media capabilities; a late login cannot install credentials into the new context. Cancelling QR pairing waits for an in-flight verification to settle. Device accounts can be forgotten while offline: local access is removed immediately after bounded network attempts, and encrypted vault credentials retry server revocation on reconnection. Account JSON stores only metadata/opaque job IDs.

Native and browser media use revocable loopback HTTP capabilities bound to server base URL/account/generation, with incremental bytes, Range/206 and conditional headers. Cookie/Bearer secrets never appear in the local URL; external redirects receive no configured-server credential. Active requests or playback heartbeats renew idle leases, while revocation cannot be undone. Expired registry entries cancel their in-flight transfers before removal. LAN discovery uses UDP 7359 and confirms MovieClaw health before offering a server.

Window close and tray Quit share a shutdown hook: the player has up to 1.5 seconds to flush progress and release sessions, after which Rust retires native authentication, cancels updates and gives verifier processes up to 750 ms to terminate before stopping the player and exiting. Changing servers cancels old network requests before the new context is used.

## Updates and rollback

Updates accept only formal GitHub releases in this repository and exact Windows x64 assets. Downloads enforce HTTPS delivery hosts, declared size, the release SHA-256 list and GitHub asset digest; cancellation drops the transfer and deletes partial files. Installation rechecks cached bytes under a file lock and verifies Authenticode. Invalid signatures are rejected; unsigned installers require explicit user confirmation. Versions without a hash list use the release-page manual path. Portable ZIPs are shown in Explorer for manual replacement after closing the application.

Keep a previous verified installer/portable archive and its SHA-256 list for rollback. Close the application before replacing binaries; preserve the current user's data/vault and avoid running different versions concurrently. Current packaging smoke covers fresh install/start/close/uninstall; it does not claim a production upgrade/rollback was exercised against every historical version.

## Upstream maintenance

`upstream-baseline.json` pins the official macOS source revision. Upstream Watch compares complete source trees for the Mac UI, shared player, API and Apple build paths, and uploads JSON/Markdown review reports. It never silently advances the baseline. Review changed behavior against the parity matrix and rerun regressions before updating this revision.
