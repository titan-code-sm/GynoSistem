; Aggiunte all'installer NSIS di Tauri (bundle.windows.nsis.installerHooks).
;
; Il disinstallatore offre la casella «Cancella i dati dell'applicazione»,
; che cancellerebbe la cartella dei dati (%APPDATA%\<identificativo>): lì ci
; sono il database delle pazienti e la copia della chiave di cifratura. Lo
; stesso disinstallatore parte anche durante un aggiornamento («Disinstalla
; prima di installare»), quindi una spunta per sbaglio farebbe perdere
; l'archivio. I dati non si cancellano mai da qui: chi vuole davvero
; eliminarli lo fa a mano, dopo un backup.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
    StrCpy $DeleteAppDataCheckboxState 0
    MessageBox MB_OK|MB_ICONINFORMATION "Per sicurezza l'archivio delle pazienti NON viene cancellato.$\n$\nI dati restano in:$\n$APPDATA\${BUNDLEID}$\n$\nSe vuoi eliminarli davvero, fai prima un backup e poi cancella quella cartella a mano."
  ${EndIf}
!macroend
