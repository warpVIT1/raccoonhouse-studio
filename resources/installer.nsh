; electron-builder's default uninstaller (Section "un.install" in its own
; templates/nsis/uninstaller.nsh) does an unconditional `RMDir /r $INSTDIR`
; on every uninstall — including the silent uninstall-then-reinstall that
; electron-updater triggers for every single auto-update. Since `data/`
; (the SQLite DB, titles/episodes/media) lives install-drive-relative
; INSIDE $INSTDIR (see electron/main.ts's data-dir resolution — moved off
; %APPDATA% deliberately), that default behavior would silently wipe every
; studio's real production data on every update. This override replaces
; the electron-builder default per-file loop with an equivalent one that
; skips the `data` subfolder, instead of hardcoding Electron's own output
; file list (which changes across Electron version bumps).
!macro customRemoveFiles
  FindFirst $0 $1 "$INSTDIR\*.*"
  loop:
    StrCmp $1 "" done
    StrCmp $1 "." next
    StrCmp $1 ".." next
    StrCmp $1 "data" next
    IfFileExists "$INSTDIR\$1\*.*" isDir isFile
    isDir:
      RMDir /r "$INSTDIR\$1"
      Goto next
    isFile:
      Delete "$INSTDIR\$1"
    next:
      FindNext $0 $1
      Goto loop
  done:
    FindClose $0
!macroend

; One-time "where should the pre-update backup of your personal data go"
; page — see backend/services/backup_service.py::get_backup_dir, which
; reads the path this writes to $INSTDIR\backup-location.txt. Only ever
; shown on a genuine first install: electron-builder's own template
; (assistedInstaller.nsh) inserts customPageAfterChangeDir unconditionally,
; unlike MUI_PAGE_DIRECTORY/licensePage which get skipPageIfUpdated'd
; automatically — so this macro guards itself by calling Abort from its
; own page-create function whenever $isUpdated is set, the standard
; nsDialogs pattern for a conditionally-skipped custom page.
!include nsDialogs.nsh
!include LogicLib.nsh

Var BackupDirPageDialog
Var BackupDirPageInput
Var BackupDirChoice

!macro customPageAfterChangeDir
  Page custom BackupDirPageCreate BackupDirPageLeave

  Function BackupDirPageCreate
    ${if} ${isUpdated}
      Abort
    ${endif}

    StrCpy $BackupDirChoice "$DOCUMENTS\RaccoonHouse Backups"

    nsDialogs::Create 1018
    Pop $BackupDirPageDialog
    ${if} $BackupDirPageDialog == error
      Abort
    ${endif}

    !insertmacro MUI_HEADER_TEXT "Резервна копія особистих даних" "Куди зберігати автоматичну резервну копію перед оновленнями програми"

    ${NSD_CreateLabel} 0 0 100% 40u "Перед кожним оновленням програма зберігатиме стиснену резервну копію ваших особистих (не спільних із командою) тайтлів і серій за цим шляхом, а після оновлення відновлює її автоматично. Оберіть папку поза $INSTDIR, щоб копія збереглася навіть при повному видаленні програми."
    Pop $0

    ${NSD_CreateDirRequest} 0 45u 75% 12u $BackupDirChoice
    Pop $BackupDirPageInput

    ${NSD_CreateBrowseButton} 77% 45u 23% 12u "Огляд..."
    Pop $0
    ${NSD_OnClick} $0 BackupDirPageBrowse

    nsDialogs::Show
  FunctionEnd

  Function BackupDirPageBrowse
    nsDialogs::SelectFolderDialog "Оберіть папку для резервних копій" $BackupDirChoice
    Pop $0
    ${if} $0 != error
      StrCpy $BackupDirChoice $0
      ${NSD_SetText} $BackupDirPageInput $BackupDirChoice
    ${endif}
  FunctionEnd

  Function BackupDirPageLeave
    ${NSD_GetText} $BackupDirPageInput $BackupDirChoice
    ${if} $BackupDirChoice == ""
      StrCpy $BackupDirChoice "$DOCUMENTS\RaccoonHouse Backups"
    ${endif}
    CreateDirectory "$INSTDIR"
    FileOpen $0 "$INSTDIR\backup-location.txt" w
    FileWrite $0 "$BackupDirChoice"
    FileClose $0
  FunctionEnd
!macroend
