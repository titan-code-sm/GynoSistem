// Chiave di cifratura del database interno: generata dall'app al primo avvio
// e custodita da Windows (Gestione credenziali, protetta dall'account Windows).
// Il file del database copiato su un altro PC o da un altro utente resta illeggibile.
const SERVIZIO: &str = "MED System Gineco";
const VOCE: &str = "chiave-database";

fn voce() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVIZIO, VOCE).map_err(|e| e.to_string())
}

#[tauri::command]
fn chiave_db_leggi() -> Result<Option<String>, String> {
    match voce()?.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn chiave_db_salva(chiave: String) -> Result<(), String> {
    voce()?.set_password(&chiave).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![chiave_db_leggi, chiave_db_salva])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di MED System Gineco");
}
