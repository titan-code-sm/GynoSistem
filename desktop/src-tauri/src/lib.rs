// Chiave di cifratura del database interno: generata dall'app al primo avvio
// e custodita da Windows (Gestione credenziali, protetta dall'account Windows).
// Il file del database copiato su un altro PC o da un altro utente resta illeggibile.
// La voce prende il nome dell'app ("MED System Gineco", "MED System"...): ogni
// versione ha la sua chiave, come ha il suo database.
//
// Copia di riserva: la stessa chiave è salvata anche in un file nella cartella
// dati dell'app, protetto con DPAPI (leggibile solo dallo stesso account
// Windows). Se la voce in Gestione credenziali sparisce, l'app la ritrova dal
// file e la ripristina, invece di perdere l'accesso ai dati.
use tauri::Manager;

const VOCE: &str = "chiave-database";
const FILE_COPIA: &str = "chiave-database.dpapi";

fn voce(app: &tauri::AppHandle) -> Result<keyring::Entry, String> {
    let servizio = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "MED System".to_string());
    keyring::Entry::new(&servizio, VOCE).map_err(|e| e.to_string())
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn ingresso(dati: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: dati.len() as u32, pbData: dati.as_ptr() as *mut u8 }
    }
    fn vuoto() -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() }
    }
    unsafe fn prendi(out: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        v
    }
    pub fn proteggi(dati: &[u8]) -> Result<Vec<u8>, String> {
        let inp = ingresso(dati);
        let mut out = vuoto();
        let ok = unsafe {
            CryptProtectData(&inp, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 { return Err("protezione DPAPI non riuscita".into()); }
        Ok(unsafe { prendi(&out) })
    }
    pub fn sproteggi(dati: &[u8]) -> Result<Vec<u8>, String> {
        let inp = ingresso(dati);
        let mut out = vuoto();
        let ok = unsafe {
            CryptUnprotectData(&inp, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 { return Err("lettura DPAPI non riuscita".into()); }
        Ok(unsafe { prendi(&out) })
    }
}

fn percorso_copia(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE_COPIA))
}

#[cfg(windows)]
fn leggi_copia(app: &tauri::AppHandle) -> Option<String> {
    let dati = std::fs::read(percorso_copia(app).ok()?).ok()?;
    String::from_utf8(dpapi::sproteggi(&dati).ok()?).ok()
}
#[cfg(not(windows))]
fn leggi_copia(_app: &tauri::AppHandle) -> Option<String> { None }

#[cfg(windows)]
fn scrivi_copia(app: &tauri::AppHandle, chiave: &str) -> Result<(), String> {
    let p = percorso_copia(app)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, dpapi::proteggi(chiave.as_bytes())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
#[cfg(not(windows))]
fn scrivi_copia(_app: &tauri::AppHandle, _chiave: &str) -> Result<(), String> { Ok(()) }

#[tauri::command]
fn chiave_db_leggi(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let entry = voce(&app)?;
    match entry.get_password() {
        Ok(k) => {
            // Crea/aggiorna la copia di riserva se manca (es. primo avvio di questa versione)
            if leggi_copia(&app).as_deref() != Some(k.as_str()) {
                let _ = scrivi_copia(&app, &k);
            }
            Ok(Some(k))
        }
        Err(keyring::Error::NoEntry) => match leggi_copia(&app) {
            Some(k) => {
                let _ = entry.set_password(&k); // ripristina la voce in Gestione credenziali
                Ok(Some(k))
            }
            None => Ok(None),
        },
        Err(e) => leggi_copia(&app).map(Some).ok_or_else(|| e.to_string()),
    }
}

#[tauri::command]
fn chiave_db_salva(app: tauri::AppHandle, chiave: String) -> Result<(), String> {
    let r1 = voce(&app)?.set_password(&chiave).map_err(|e| e.to_string());
    let r2 = scrivi_copia(&app, &chiave);
    match (r1, r2) {
        (Err(a), Err(b)) => Err(format!("{a}; {b}")),
        _ => Ok(()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![chiave_db_leggi, chiave_db_salva])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di MED System");
}
