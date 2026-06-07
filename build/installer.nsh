!macro customRemoveFiles
  RMDir /r "$INSTDIR"
!macroend

!macro customUnInstall
  DetailPrint "Removing StudyPilot local cache and login data..."

  SetShellVarContext current
  RMDir /r "$APPDATA\study-pilot"
  RMDir /r "$APPDATA\学习通答题辅助工具"
  RMDir /r "$LOCALAPPDATA\study-pilot"
  RMDir /r "$LOCALAPPDATA\学习通答题辅助工具"
  RMDir /r "$LOCALAPPDATA\com.studypilot.desktop"
  RMDir /r "$APPDATA\com.studypilot.desktop"
!macroend
