!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "TextFunc.nsh"

# The custom process-check wrapper must supply these upstream dependencies.
!include "getProcessInfo.nsh"
Var pid

!ifdef BUILD_UNINSTALLER
  # All six fixed roots are handled below, after checking retention flags.
  !ifdef DELETE_APP_DATA_ON_UNINSTALL
    !undef DELETE_APP_DATA_ON_UNINSTALL
  !endif
!else
  Var StudyPilotMigrationId
  Var StudyPilotMigrationResult
!endif

!macro customCheckAppRunning
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    # Runs before uninstallOldVersion, including the first upgrade from v1.4.2.
    File /oname=$PLUGINSDIR\session-migration.ps1 "${BUILD_RESOURCES_DIR}\session-migration.ps1"
    DetailPrint "Verifying a recovery backup of StudyPilot profile data..."
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\session-migration.ps1" -Action Backup'
    Pop $StudyPilotMigrationResult
    Pop $StudyPilotMigrationId
    ${TrimNewLines} "$StudyPilotMigrationId" $StudyPilotMigrationId
    ${if} $StudyPilotMigrationResult != 0
      MessageBox MB_OK|MB_ICONSTOP "Profile backup failed. Close StudyPilot and retry. Installation stopped before removing the existing version." /SD IDOK
      SetErrorLevel 1
      Quit
    ${endif}
    StrLen $0 $StudyPilotMigrationId
    ${if} $0 != 32
      MessageBox MB_OK|MB_ICONSTOP "Profile backup did not return a valid recovery ID. Installation stopped before removing the existing version." /SD IDOK
      SetErrorLevel 1
      Quit
    ${endif}
  !endif
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    # The mutex and process-check macros both define loop labels; keep them in separate functions.
    Function StudyPilotPrepareUpgrade
      InitPluginsDir
      !insertmacro customCheckAppRunning
    FunctionEnd
  !endif
!macroend

!macro customInit
  !ifndef BUILD_UNINSTALLER
    # Assisted per-machine installs skip CHECK_APP_RUNNING in their inner process.
    ${if} ${UAC_IsInnerInstance}
      Call StudyPilotPrepareUpgrade
    ${endif}
  !endif
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    # Abort before the finish-page/silent launch paths if restoration cannot verify.
    ${if} $StudyPilotMigrationId == ""
      MessageBox MB_OK|MB_ICONSTOP "Profile recovery ID is missing. Automatic launch is blocked. Rerun the installer as the account that uses StudyPilot." /SD IDOK
      SetErrorLevel 1
      Quit
    ${endif}
    DetailPrint "Restoring and verifying StudyPilot profile data..."
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\session-migration.ps1" -Action Restore -MigrationId "$StudyPilotMigrationId"'
    Pop $StudyPilotMigrationResult
    Pop $0
    ${if} $StudyPilotMigrationResult != 0
      MessageBox MB_OK|MB_ICONSTOP "Profile recovery failed. Automatic launch is blocked. Keep %LOCALAPPDATA%\StudyPilotUpgradeBackup\$StudyPilotMigrationId (including session-migration.ps1 and manifest.json) and rerun the installer before starting StudyPilot." /SD IDOK
      SetErrorLevel 1
      Quit
    ${endif}
  !endif
!macroend

!macro customRemoveFiles
  RMDir /r "$INSTDIR"
!macroend

!macro customUnInit
  # The template handles explicit deletion before customUnInstall; reject conflicts here.
  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "--delete-app-data" $1
  ${ifNot} ${Errors}
    StrCpy $2 "0"
    ${if} ${isUpdated}
      StrCpy $2 "1"
    ${else}
      ClearErrors
      ${GetOptions} $0 "/KEEP_APP_DATA" $1
      ${ifNot} ${Errors}
        StrCpy $2 "1"
      ${endif}
    ${endif}
    ${if} $2 == "1"
      MessageBox MB_OK|MB_ICONSTOP "Conflicting profile options: data retention and --delete-app-data cannot be combined. Uninstall stopped before deleting files or profile data." /SD IDOK
      SetErrorLevel 1
      Quit
    ${endif}
  ${endif}
  ClearErrors
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ClearErrors
    ${GetParameters} $0
    ${GetOptions} $0 "/KEEP_APP_DATA" $1
    ${if} ${Errors}
      DetailPrint "Removing StudyPilot local cache and login data..."
      SetShellVarContext current
      RMDir /r "$APPDATA\study-pilot"
      RMDir /r "$APPDATA\学习通答题辅助工具"
      RMDir /r "$LOCALAPPDATA\study-pilot"
      RMDir /r "$LOCALAPPDATA\学习通答题辅助工具"
      RMDir /r "$LOCALAPPDATA\com.studypilot.desktop"
      RMDir /r "$APPDATA\com.studypilot.desktop"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    ${endif}
  ${endif}
!macroend
