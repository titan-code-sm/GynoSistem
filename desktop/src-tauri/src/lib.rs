// Segreti dell'app custoditi da Windows (Gestione credenziali, protetta
// dall'account Windows):
//  - "chiave-database": chiave di cifratura del database interno, generata
//    dall'app al primo avvio. Il file del database copiato su un altro PC o da
//    un altro utente resta illeggibile.
//  - "password-backup": password scelta dall'operatore per i backup automatici.
// La voce prende il nome dell'app ("MED System Gineco", "MED System"...): ogni
// versione ha i suoi segreti, come ha il suo database.
//
// Copia di riserva: ogni segreto è salvato anche in un file nella cartella
// dati dell'app, protetto con DPAPI (leggibile solo dallo stesso account
// Windows). Se la voce in Gestione credenziali sparisce, l'app la ritrova dal
// file e la ripristina, invece di perdere l'accesso ai dati.
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const CHIAVE_DB: &str = "chiave-database";
const SEGRETI_AMMESSI: [&str; 1] = ["password-backup"];

fn voce(app: &tauri::AppHandle, nome: &str) -> Result<keyring::Entry, String> {
    let servizio = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "MED System".to_string());
    keyring::Entry::new(&servizio, nome).map_err(|e| e.to_string())
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

fn percorso_copia(app: &tauri::AppHandle, nome: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{nome}.dpapi")))
}

#[cfg(windows)]
fn leggi_copia(app: &tauri::AppHandle, nome: &str) -> Option<String> {
    let dati = std::fs::read(percorso_copia(app, nome).ok()?).ok()?;
    String::from_utf8(dpapi::sproteggi(&dati).ok()?).ok()
}
#[cfg(not(windows))]
fn leggi_copia(_app: &tauri::AppHandle, _nome: &str) -> Option<String> { None }

#[cfg(windows)]
fn scrivi_copia(app: &tauri::AppHandle, nome: &str, valore: &str) -> Result<(), String> {
    let p = percorso_copia(app, nome)?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, dpapi::proteggi(valore.as_bytes())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}
#[cfg(not(windows))]
fn scrivi_copia(_app: &tauri::AppHandle, _nome: &str, _valore: &str) -> Result<(), String> { Ok(()) }

fn segreto_leggi_interno(app: &tauri::AppHandle, nome: &str) -> Result<Option<String>, String> {
    let entry = voce(app, nome)?;
    match entry.get_password() {
        Ok(k) => {
            // Crea/aggiorna la copia di riserva se manca (es. primo avvio di questa versione)
            if leggi_copia(app, nome).as_deref() != Some(k.as_str()) {
                let _ = scrivi_copia(app, nome, &k);
            }
            Ok(Some(k))
        }
        Err(keyring::Error::NoEntry) => match leggi_copia(app, nome) {
            Some(k) => {
                let _ = entry.set_password(&k); // ripristina la voce in Gestione credenziali
                Ok(Some(k))
            }
            None => Ok(None),
        },
        Err(e) => leggi_copia(app, nome).map(Some).ok_or_else(|| e.to_string()),
    }
}

fn segreto_salva_interno(app: &tauri::AppHandle, nome: &str, valore: &str) -> Result<(), String> {
    let r1 = voce(app, nome)?.set_password(valore).map_err(|e| e.to_string());
    let r2 = scrivi_copia(app, nome, valore);
    match (r1, r2) {
        (Err(a), Err(b)) => Err(format!("{a}; {b}")),
        _ => Ok(()),
    }
}

#[tauri::command]
fn chiave_db_leggi(app: tauri::AppHandle) -> Result<Option<String>, String> {
    segreto_leggi_interno(&app, CHIAVE_DB)
}

#[tauri::command]
fn chiave_db_salva(app: tauri::AppHandle, chiave: String) -> Result<(), String> {
    segreto_salva_interno(&app, CHIAVE_DB, &chiave)
}

#[tauri::command]
fn segreto_leggi(app: tauri::AppHandle, nome: String) -> Result<Option<String>, String> {
    if !SEGRETI_AMMESSI.contains(&nome.as_str()) { return Err("segreto non ammesso".into()); }
    segreto_leggi_interno(&app, &nome)
}

#[tauri::command]
fn segreto_salva(app: tauri::AppHandle, nome: String, valore: String) -> Result<(), String> {
    if !SEGRETI_AMMESSI.contains(&nome.as_str()) { return Err("segreto non ammesso".into()); }
    segreto_salva_interno(&app, &nome, &valore)
}

// ── Backup automatici cifrati in una cartella scelta dall'operatore ──
// Il contenuto arriva già cifrato dall'app; qui si scrive il file e si
// tengono solo gli ultimi `tieni` della stessa serie (stesso prefisso prima
// di "_auto_"), senza mai toccare altri file della cartella.

#[derive(serde::Serialize)]
struct FileBackup { nome: String, byte: u64, modificato: u64 }

fn nome_valido(nome: &str) -> bool {
    let ok_car = nome.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.');
    ok_car && nome.ends_with(".json") && nome.contains("_auto_") && !nome.contains("..") && nome.len() < 120
}
fn serie(nome: &str) -> &str { nome.split("_auto_").next().unwrap_or("") }

fn elenca(cartella: &std::path::Path, prefisso: &str) -> Vec<FileBackup> {
    let mut v: Vec<FileBackup> = std::fs::read_dir(cartella)
        .map(|it| it.filter_map(|e| e.ok()).filter_map(|e| {
            let nome = e.file_name().to_string_lossy().to_string();
            if !nome_valido(&nome) || serie(&nome) != prefisso { return None; }
            let meta = e.metadata().ok()?;
            let modificato = meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64).unwrap_or(0);
            Some(FileBackup { nome, byte: meta.len(), modificato })
        }).collect())
        .unwrap_or_default();
    v.sort_by(|a, b| b.nome.cmp(&a.nome)); // il nome contiene data e ora: più recente prima
    v
}

#[tauri::command]
async fn backup_scegli_cartella(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let scelta = app.dialog().file().set_title("Cartella dei backup automatici").blocking_pick_folder();
    Ok(scelta.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn backup_scrivi(cartella: String, nome: String, contenuto: String, tieni: usize) -> Result<Vec<FileBackup>, String> {
    if !nome_valido(&nome) { return Err("nome del file non valido".into()); }
    let dir = std::path::PathBuf::from(&cartella);
    if !dir.is_dir() { return Err("la cartella dei backup non è raggiungibile (chiavetta o disco scollegato?)".into()); }
    let dest = dir.join(&nome);
    let tmp = dir.join(format!("{nome}.tmp"));
    std::fs::write(&tmp, contenuto.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    let prefisso = serie(&nome).to_string();
    let lista = elenca(&dir, &prefisso);
    for vecchio in lista.iter().skip(tieni.max(1)) {
        let _ = std::fs::remove_file(dir.join(&vecchio.nome));
    }
    Ok(elenca(&dir, &prefisso))
}

#[tauri::command]
fn backup_elenca(cartella: String, prefisso: String) -> Vec<FileBackup> {
    elenca(std::path::Path::new(&cartella), &prefisso)
}

// ── PDF generati dall'app (referto, cartella) ──
// La finestra dell'app non gestisce bene i download: il PDF arriva qui come
// byte grezzi, l'operatore sceglie dove salvarlo («Salva con nome») e il file
// si apre subito nel lettore PDF di Windows. None = salvataggio annullato.
#[tauri::command]
async fn pdf_salva(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    let tauri::ipc::InvokeBody::Raw(dati) = request.body() else { return Err("contenuto del PDF mancante".into()) };
    if !dati.starts_with(b"%PDF") { return Err("il file generato non è un PDF".into()); }
    let nome = request.headers().get("x-nome").and_then(|v| v.to_str().ok()).unwrap_or("documento.pdf");
    let nome: String = percent_decode(nome).chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' || c == ' ' { c } else { '_' })
        .take(120).collect();
    let nome = if nome.to_lowercase().ends_with(".pdf") { nome } else { format!("{nome}.pdf") };
    let mut dialogo = app.dialog().file().set_title("Salva PDF").set_file_name(&nome).add_filter("PDF", &["pdf"]);
    if let Ok(doc) = app.path().document_dir() { dialogo = dialogo.set_directory(doc); }
    let Some(dest) = dialogo.blocking_save_file().and_then(|p| p.into_path().ok()) else { return Ok(None) };
    std::fs::write(&dest, dati).map_err(|e| format!("impossibile salvare il file: {e}"))?;
    let _ = app.opener().open_path(dest.to_string_lossy(), None::<&str>);
    Ok(Some(dest.to_string_lossy().to_string()))
}
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Versione nel titolo della finestra: «MED System Gineco · v1.7.8»
        .setup(|app| {
            if let Some(finestra) = app.get_webview_window("main") {
                let nome = app.config().product_name.clone().unwrap_or_else(|| "MED System".to_string());
                let _ = finestra.set_title(&format!("{} · v{}", nome, app.package_info().version));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chiave_db_leggi, chiave_db_salva, segreto_leggi, segreto_salva,
            backup_scegli_cartella, backup_scrivi, backup_elenca, pdf_salva
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio di MED System");
}
