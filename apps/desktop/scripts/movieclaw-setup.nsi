; MovieClaw Desktop — NSIS 安装脚本
; 编译: makensis movieclaw-setup.nsi
; 需要: NSIS 3.x

!include "MUI2.nsh"
!include "FileFunc.nsh"

Name "MovieClaw Desktop"
OutFile "..\dist\MovieClaw-Desktop-v0.2.107-Setup-x64.exe"
InstallDir "$LOCALAPPDATA\MovieClaw\Desktop"
InstallDirRegKey HKCU "Software\MovieClaw\Desktop" "InstallDir"
RequestExecutionLevel user
Unicode True

!define APP_NAME "MovieClaw Desktop"
!define APP_VERSION "0.2.107"
!define APP_PUBLISHER "MovieClaw"
!define APP_EXE "movieclaw-desktop.exe"

; MUI 设置
!define MUI_ICON "..\src-tauri\icons\icon.ico"
!define MUI_UNICON "..\src-tauri\icons\icon.ico"
!define MUI_ABORTWARNING

; 页面
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; 语言
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "安装" SecInstall
    SetOutPath "$INSTDIR"

    ; 主程序
    File "..\dist\portable\movieclaw-desktop.exe"
    File "..\dist\portable\connect.html"
    File "..\dist\portable\inject.js"
    File "..\dist\portable\volume-overlay.html"
    File "..\dist\portable\WebView2Loader.dll"
    ; 桌面 UI
    File /nonfatal /r "..\dist\portable\desktop"
    ; mpv sidecar (放入 mpv 子目录)
    SetOutPath "$INSTDIR\mpv"
    File /nonfatal /r "..\dist\portable\mpv\*.*"
    SetOutPath "$INSTDIR"

    ; 写注册表
    WriteRegStr HKCU "Software\MovieClaw\Desktop" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\MovieClaw\Desktop" "Version" "${APP_VERSION}"

    ; 卸载程序
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; 添加/删除程序
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MovieClawDesktop" "DisplayName" "${APP_NAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MovieClawDesktop" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MovieClawDesktop" "Publisher" "${APP_PUBLISHER}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MovieClawDesktop" "UninstallString" "$INSTDIR\uninstall.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MovieClawDesktop" "InstallLocation" "$INSTDIR"

    ; 桌面快捷方式
    CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

    ; 开始菜单
    CreateDirectory "$SMPROGRAMS\MovieClaw"
    CreateShortCut "$SMPROGRAMS\MovieClaw\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
    CreateShortCut "$SMPROGRAMS\MovieClaw\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
    Delete "$INSTDIR\${APP_EXE}"
    Delete "$INSTDIR\connect.html"
    Delete "$INSTDIR\inject.js"
    Delete "$INSTDIR\volume-overlay.html"
    Delete "$INSTDIR\WebView2Loader.dll"
    RMDir /r "$INSTDIR\desktop"
    RMDir /r "$INSTDIR\mpv"
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"

    DeleteRegKey HKCU "Software\MovieClaw\Desktop"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MovieClawDesktop"

    Delete "$DESKTOP\${APP_NAME}.lnk"
    RMDir /r "$SMPROGRAMS\MovieClaw"
SectionEnd
