!include "FileFunc.nsh"
!include "LogicLib.nsh"

; electron-builder first compiles and executes a temporary BUILD_UNINSTALLER
; pass. Migration hooks belong only to the final installer; excluding them from
; that pass also keeps makensis -WX free of unused-variable warnings.
!ifndef BUILD_UNINSTALLER
; The published v1.0.0 installer had no explicit bundle.publisher. Tauri
; derived `miyakey` from `com.miyakey.grimodex`, so these values intentionally
; differ from the publisher now present in tauri.conf.json.
!define TAURI_V1_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Grimodex"
!define TAURI_V1_PRODUCT_KEY "Software\miyakey\Grimodex"

Var TauriV1Directory
Var TauriV1Migrated
Var TauriBridgeRestart

; Tauri updater launches an NSIS replacement with /P (passive), /R (restart),
; /UPDATE and optionally /ARGS. electron-builder uses a different flag set,
; so translate the two behaviours that must survive the shell migration.
!macro preInit
  StrCpy $TauriBridgeRestart 0
  ${GetParameters} $R0

  ClearErrors
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}

  ClearErrors
  ${GetOptions} $R0 "/R" $R1
  ${IfNot} ${Errors}
    StrCpy $TauriBridgeRestart 1
  ${EndIf}
!macroend

; This runs after electron-builder chooses CurrentUser mode but before it
; changes files. Detect only the exact published Tauri identity and invoke its
; known uninstaller path. Never execute the registry's raw UninstallString.
!macro customInit
  StrCpy $TauriV1Migrated 0
  ReadRegStr $R0 HKCU "${TAURI_V1_UNINSTALL_KEY}" "DisplayName"
  ReadRegStr $R1 HKCU "${TAURI_V1_UNINSTALL_KEY}" "Publisher"
  ReadRegStr $R4 HKCU "${TAURI_V1_UNINSTALL_KEY}" "UninstallString"
  ReadRegStr $TauriV1Directory HKCU "${TAURI_V1_PRODUCT_KEY}" ""

  ${If} $R0 == ""
  ${AndIf} $R1 == ""
  ${AndIf} $R4 == ""
  ${AndIf} $TauriV1Directory == ""
    ; No Tauri v1 installation is registered for the current user.
  ${ElseIf} $R0 == "Grimodex"
  ${AndIf} $R1 == "miyakey"
  ${AndIf} $R4 != ""
  ${AndIf} $TauriV1Directory != ""
  ${AndIf} ${FileExists} "$TauriV1Directory\uninstall.exe"
  ${AndIf} ${FileExists} "$TauriV1Directory\grimodex.exe"
    ClearErrors
    ExecWait '"$TauriV1Directory\uninstall.exe" /P /UPDATE _?=$TauriV1Directory' $R2
    ${If} ${Errors}
    ${OrIf} $R2 != 0
      SetErrorLevel 1
      Abort "Failed to remove the previous Grimodex installation."
    ${EndIf}

    ReadRegStr $R3 HKCU "${TAURI_V1_UNINSTALL_KEY}" "UninstallString"
    ${If} $R3 != ""
      SetErrorLevel 1
      Abort "Previous Grimodex uninstall registration remains."
    ${EndIf}
    StrCpy $TauriV1Migrated 1
  ${Else}
    ; A partial or unexpected registration must not become a side-by-side
    ; install. Leave the old files and all user data untouched for recovery.
    SetErrorLevel 1
    Abort "The previous Grimodex installation could not be validated."
  ${EndIf}
!macroend

; customInstall runs only after the Electron payload, registry entry and
; shortcuts were written successfully. Tauri /UPDATE can intentionally leave
; installer bookkeeping, so remove only those known values and empty folders.
; User data lives elsewhere and is deliberately never referenced here.
!macro customInstall
  ${If} $TauriV1Migrated == 1
    DeleteRegValue HKCU "${TAURI_V1_PRODUCT_KEY}" ""
    DeleteRegValue HKCU "${TAURI_V1_PRODUCT_KEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${TAURI_V1_PRODUCT_KEY}"
    DeleteRegKey /ifempty HKCU "Software\miyakey"
    Delete /REBOOTOK "$TauriV1Directory\uninstall.exe"
    RMDir /REBOOTOK "$TauriV1Directory"
  ${EndIf}

  ${If} $TauriBridgeRestart == 1
  ${AndIf} ${Silent}
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/ARGS" $R1
    ${If} ${Errors}
      StrCpy $R1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $R2 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$R1"
  ${EndIf}
!macroend
!endif
