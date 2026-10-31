/**
 * MED System — Cloud Functions
 *
 * Firebase è usato SOLO per gli account: nessun dato clinico, nessuna
 * anagrafica, nessun appuntamento passa da qui. Tre funzioni:
 *
 *  - portaleUtenti: gestione degli account dal portale dell'amministratore
 *    (elenco, creazione, blocco/sblocco, password provvisoria, eliminazione).
 *    Usa l'Admin SDK, quindi agisce davvero sull'account di accesso (un
 *    account bloccato non può più entrare, una password provvisoria sostituisce
 *    quella dimenticata) e invio al medico, per email, del link al programma
 *    da installare (ultima release su GitHub).
 *  - inviaEmail: invio delle email alle pazienti dalla sezione "Email"
 *    dell'app. Non conserva nulla: l'archivio delle email inviate resta
 *    nell'app, sul PC. Su Firestore rimane solo un contatore giornaliero
 *    (numero di email inviate, nessun indirizzo né testo) per il limite anti-abuso.
 *  - scaricaProgrammaDemo: dal sito dimostrativo, chi ha la password di
 *    download generata nel portale riceve i link agli installer dell'ultima
 *    versione pubblicata.
 *  - pacchettoMedico: le modifiche ai testi (frasi pronte, consensi, schemi)
 *    che il medico salva nell'app entrano nel suo pacchetto studio.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

initializeApp();
const db = getFirestore();
const auth = getAuth();

const ADMIN_EMAIL = "titancodesm@gmail.com";
const REGIONE = "europe-west1";

// Account Gmail dello studio da cui partono le email alle pazienti. EMAIL_PASS
// è una "password per le app" di Google (16 caratteri), MAI la password vera.
const EMAIL_USER = defineSecret("EMAIL_USER");
const EMAIL_PASS = defineSecret("EMAIL_PASS");

function soloAmministratore(request) {
  if (!request.auth || request.auth.token.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Operazione riservata all'amministratore.");
  }
}

function controllaPassword(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new HttpsError("invalid-argument", "La password deve avere almeno 8 caratteri.");
  }
}

const GENERI = ["f", "m", "n"];
// Licenze: piano di attivazione e versione dell'app (modello) di ogni account.
const PIANI = ["prova", "gratis", "mensile", "annuale", "vita"];
const MODELLI = ["gineco", "base", "proct"];
const SCONTI = ["", "conoscente", "amico", "personalizzato"];
const METODI = ["contanti", "bonifico", "altro"];
const reData = /^\d{4}-\d{2}-\d{2}$/;
function testo(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
// Campi della licenza ricevuti dal portale, validati (solo quelli presenti).
function campiLicenza(d) {
  const c = {};
  if (PIANI.includes(d.piano)) c.piano = d.piano;
  if (MODELLI.includes(d.modello)) c.modello = d.modello;
  if (SCONTI.includes(d.sconto)) c.sconto = d.sconto;
  if (d.scadenza === "" || (typeof d.scadenza === "string" && reData.test(d.scadenza))) c.scadenza = d.scadenza;
  if (typeof d.prezzo === "number" && d.prezzo >= 0 && d.prezzo < 100000) c.prezzo = Math.round(d.prezzo * 100) / 100;
  if (typeof d.noteLicenza === "string") c.noteLicenza = testo(d.noteLicenza, 500);
  return c;
}

// ── Pacchetti studio ──
const MAX_PACCHETTO = 800 * 1024; // byte (il limite di un documento Firestore è 1 MiB)
function soloTesti(o) { return o && typeof o === "object" && !Array.isArray(o) && Object.entries(o).every(([k, v]) => typeof k === "string" && typeof v === "string"); }
function pulisciPacchetto(p) {
  if (!p || typeof p !== "object") throw new HttpsError("invalid-argument", "Pacchetto non valido.");
  const out = { nome: testo(p.nome, 80), sezioni: {} };
  for (const [id, val] of Object.entries(p.sezioni || {})) {
    if (!/^[\w-]{1,60}$/.test(id)) continue;
    if (Array.isArray(val) && val.every((x) => typeof x === "string")) out.sezioni[id] = val;
    else if (soloTesti(val)) out.sezioni[id] = val;
  }
  const lista = (arr, campi) => (Array.isArray(arr) ? arr : []).filter((x) => x && typeof x.titolo === "string" && typeof x.testo === "string")
    .map((x) => Object.fromEntries(campi.filter((c) => typeof x[c] === "string").map((c) => [c, x[c]])));
  // Ordine delle voci di ogni sezione (Firestore restituisce le chiavi di una
  // mappa in ordine alfabetico): solo per sezioni a voci {titolo: testo}.
  if (p.ordine && typeof p.ordine === "object") {
    const ordine = {};
    for (const [id, arr] of Object.entries(p.ordine)) {
      const sez = out.sezioni[id];
      if (!sez || Array.isArray(sez) || !Array.isArray(arr)) continue;
      const titoli = arr.filter((t) => typeof t === "string" && Object.prototype.hasOwnProperty.call(sez, t));
      if (titoli.length) ordine[id] = [...new Set(titoli)];
    }
    if (Object.keys(ordine).length) out.ordine = ordine;
  }
  if (Array.isArray(p.consensi)) out.consensi = lista(p.consensi, ["titolo", "testo", "pdfUfficiale"]);
  if (Array.isArray(p.schemi)) out.schemi = lista(p.schemi, ["titolo", "testo"]);
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_PACCHETTO) throw new HttpsError("invalid-argument", "Pacchetto troppo grande.");
  return out;
}
async function archiviaVersione(ref, da) {
  const attuale = await ref.get();
  await ref.collection("versioni").add({ salvato: new Date().toISOString(), da, pacchetto: attuale.exists ? attuale.data() : null });
  const vecchie = await ref.collection("versioni").orderBy("salvato", "desc").offset(20).get();
  await Promise.all(vecchie.docs.map((v) => v.ref.delete()));
}
async function salvaPacchetto(uid, p, da) {
  const ref = db.collection("pacchetti").doc(uid);
  await archiviaVersione(ref, da);
  await ref.set({ ...p, aggiornato: new Date().toISOString(), da });
}
async function eliminaPacchetto(uid, da) {
  const ref = db.collection("pacchetti").doc(uid);
  await archiviaVersione(ref, da);
  await ref.delete();
}

// ═══════════════════════════════════════════════════════════
//  PACCHETTO DEL MEDICO (dall'app, per il proprio account)
// ═══════════════════════════════════════════════════════════
// Quando il medico salva frasi pronte, consensi o schemi di prescrizione
// nell'app, la modifica entra nel suo pacchetto: l'amministratore la ritrova
// nel portale (con la versione precedente tra le versioni) e il medico su
// ogni PC. Riceve una sola modifica alla volta:
//   { tipo:"sezione", id, valore }  |  { tipo:"consensi"|"schemi", valore }
// valore null toglie quella parte dal pacchetto (tornano i testi del programma).
exports.pacchettoMedico = onCall({ region: REGIONE, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Accesso richiesto.");
  const uid = request.auth.uid;
  const profilo = await db.collection("utenti").doc(uid).get();
  if (!profilo.exists || profilo.data().attivo === false) throw new HttpsError("permission-denied", "Account non abilitato.");
  const d = request.data || {};
  const ref = db.collection("pacchetti").doc(uid);
  const doc = await ref.get();
  const attuale = doc.exists ? doc.data() : {};
  const p = { nome: attuale.nome || "", sezioni: { ...(attuale.sezioni || {}) }, ordine: { ...(attuale.ordine || {}) } };
  if (attuale.consensi) p.consensi = attuale.consensi;
  if (attuale.schemi) p.schemi = attuale.schemi;
  if (d.tipo === "sezione") {
    if (typeof d.id !== "string" || !/^[\w-]{1,60}$/.test(d.id)) throw new HttpsError("invalid-argument", "Sezione non valida.");
    if (d.valore === null) delete p.sezioni[d.id];
    else p.sezioni[d.id] = d.valore;
    if (Array.isArray(d.ordine)) p.ordine[d.id] = d.ordine;
    else delete p.ordine[d.id];
  } else if (d.tipo === "consensi" || d.tipo === "schemi") {
    if (d.valore === null) delete p[d.tipo];
    else p[d.tipo] = d.valore;
  } else {
    throw new HttpsError("invalid-argument", "Modifica non riconosciuta.");
  }
  const pulito = pulisciPacchetto(p);
  if (d.tipo === "sezione" && d.valore !== null && pulito.sezioni[d.id] === undefined) throw new HttpsError("invalid-argument", "Testi della sezione non validi.");
  await salvaPacchetto(uid, pulito, request.auth.token.email || uid);
  return { pacchetto: (await ref.get()).data() };
});

// ═══════════════════════════════════════════════════════════
//  PORTALE UTENTI (solo amministratore)
// ═══════════════════════════════════════════════════════════
// La più recente tra due date (ISO o formato HTTP), come ISO; "" se nessuna è valida.
function piuRecente(...date) {
  const ms = date.map((d) => (d ? Date.parse(d) : NaN)).filter((n) => !isNaN(n));
  return ms.length ? new Date(Math.max(...ms)).toISOString() : "";
}

// ── Invio del programma da installare al medico ──
// L'installer (.exe) non va in allegato: Gmail blocca gli eseguibili e il file
// è grande. L'email contiene il link all'ultima release pubblicata su GitHub,
// scelta in base alla versione dell'app (modello) dell'account.
const RELEASE_API = "https://api.github.com/repos/titan-code-sm/GynoSistem/releases/latest";
const NOMI_MODELLO = { gineco: "MED System Gineco", proct: "MED System Proct", base: "MED System" };
function modelloDelFile(nome) { return /proct/i.test(nome) ? "proct" : /gineco/i.test(nome) ? "gineco" : "base"; }
async function ultimaRelease() {
  let r;
  try {
    r = await fetch(RELEASE_API, { headers: { "User-Agent": "medsystem-portale", Accept: "application/vnd.github+json" } });
  } catch (e) {
    throw new HttpsError("unavailable", "GitHub non raggiungibile: riprova tra poco.");
  }
  if (r.status === 404) throw new HttpsError("not-found", "Nessuna versione del programma pubblicata.");
  if (!r.ok) throw new HttpsError("unavailable", `GitHub non raggiungibile (${r.status}).`);
  const rel = await r.json();
  const exe = (rel.assets || []).filter((a) => /\.exe$/i.test(a.name));
  if (!exe.length) throw new HttpsError("not-found", "L'ultima versione pubblicata non contiene installer.");
  return { versione: String(rel.tag_name || "").replace(/^desktop-v/, ""), exe };
}
function escHtml(t) { return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function emailProgramma({ nome, genere, email, nomeApp, versione, link, mb, nota, password }) {
  const saluto = genere === "f" ? `Gentile Dott.ssa ${nome}` : genere === "m" ? `Gentile Dott. ${nome}` : `Gentile ${nome}`;
  const righe = [
    `${saluto},`,
    "",
    `ecco il programma ${nomeApp} (versione ${versione}) da installare sul PC dello studio.`,
    "",
    "1. Scarica l'installer da questo link (Windows, " + mb + " MB):",
    `   ${link}`,
    "2. Apri il file scaricato e segui le istruzioni.",
    "   Se Windows mostra «Windows ha protetto il PC», clicca «Ulteriori informazioni» e poi «Esegui comunque».",
    "3. Apri MED System e accedi con il tuo account:",
    `   Email: ${email}`,
    ...(password ? [`   Password provvisoria: ${password}`, "   Al primo accesso il programma ti chiederà di sceglierne una tua."] : ["   La password è quella che usi già (o quella che ti è stata comunicata)."]),
    "",
    "I dati delle pazienti restano solo sul tuo PC: non passano da internet.",
  ];
  if (nota) righe.push("", nota);
  righe.push("", "Per qualsiasi problema rispondi a questa email.", "", "MED System");
  const testo = righe.join("\n");
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0f172a;max-width:560px">
<p>${escHtml(saluto)},</p>
<p>ecco il programma <b>${escHtml(nomeApp)}</b> (versione ${escHtml(versione)}) da installare sul PC dello studio.</p>
<p style="margin:22px 0"><a href="${escHtml(link)}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">⬇ Scarica ${escHtml(nomeApp)}</a><br><span style="color:#64748b;font-size:13px">Windows · ${escHtml(mb)} MB</span></p>
<ol style="padding-left:20px">
<li>Apri il file scaricato e segui le istruzioni. Se Windows mostra «Windows ha protetto il PC», clicca <b>Ulteriori informazioni</b> e poi <b>Esegui comunque</b>.</li>
<li>Apri MED System e accedi con il tuo account:<br>Email: <b>${escHtml(email)}</b>${password ? `<br>Password provvisoria: <b style="font-family:Consolas,monospace">${escHtml(password)}</b><br><span style="color:#64748b">Al primo accesso il programma ti chiederà di sceglierne una tua.</span>` : "<br><span style=\"color:#64748b\">La password è quella che usi già (o quella che ti è stata comunicata).</span>"}</li>
</ol>
<p style="color:#64748b">I dati delle pazienti restano solo sul tuo PC: non passano da internet.</p>
${nota ? `<p>${escHtml(nota).replace(/\n/g, "<br>")}</p>` : ""}
<p>Per qualsiasi problema rispondi a questa email.</p>
<p>MED System</p>
<p style="color:#94a3b8;font-size:12px">Se il pulsante non funziona, copia questo indirizzo nel browser:<br>${escHtml(link)}</p>
</div>`;
  return { testo, html };
}

// ── Password di download del sito demo ──
// Generata dal portale (Sito demo → Download del programma): chi la conosce
// può scaricare dal sito dimostrativo l'ultima versione del programma.
// Sta in config/downloadDemo, che le regole di Firestore non fanno leggere a
// nessuno: solo le funzioni (Admin SDK) la vedono.
const RIF_PASSWORD_DOWNLOAD = () => db.collection("config").doc("downloadDemo");
const ALFABETO_PASSWORD = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente 0/O, 1/I/L
function nuovaPasswordDownload() {
  const b = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += ALFABETO_PASSWORD[b[i] % ALFABETO_PASSWORD.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
function normalizzaPasswordDownload(p) { return String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function statoPasswordDownload(doc) {
  if (!doc.exists || !doc.data().password) return { attiva: false };
  const x = doc.data();
  return {
    attiva: true, password: x.password, creata: x.creata || null, scadenza: x.scadenza || "",
    scaduta: !!(x.scadenza && x.scadenza < new Date().toISOString().slice(0, 10)),
    download: x.download || 0, ultimoDownload: x.ultimoDownload || null,
  };
}

exports.portaleUtenti = onCall({ secrets: [EMAIL_USER, EMAIL_PASS], region: REGIONE, timeoutSeconds: 60, memory: "256MiB" }, async (request) => {
  soloAmministratore(request);
  const d = request.data || {};
  const azione = d.azione;
  const io = request.auth.uid;
  const uid = typeof d.uid === "string" ? d.uid : "";
  const nonSuSeStesso = () => {
    if (uid === io) throw new HttpsError("failed-precondition", "Non puoi eseguire questa operazione sul tuo stesso account.");
  };

  if (azione === "elenco") {
    const [lista, docs, pacc] = await Promise.all([auth.listUsers(1000), db.collection("utenti").get(), db.collection("pacchetti").get()]);
    const profili = {}, pacchetti = {};
    docs.forEach((doc) => { profili[doc.id] = doc.data(); });
    pacc.forEach((doc) => { const d = doc.data(); pacchetti[doc.id] = { nome: d.nome || "", aggiornato: d.aggiornato || "", da: d.da || "" }; });
    return {
      utenti: lista.users.map((u) => {
        const p = profili[u.uid] || {};
        return {
          uid: u.uid,
          email: u.email || "",
          nome: p.nome || u.displayName || "",
          genere: GENERI.includes(p.genere) ? p.genere : "n",
          bloccato: u.disabled === true || p.attivo === false,
          autorizzato: !!profili[u.uid], // senza profilo l'app nega l'accesso
          passwordProvvisoria: p.mustChangePassword === true,
          demoMode: p.demoMode === true,
          piano: p.piano || "",
          modello: p.modello || "",
          sconto: p.sconto || "",
          scadenza: p.scadenza || "",
          prezzo: typeof p.prezzo === "number" ? p.prezzo : null,
          noteLicenza: p.noteLicenza || "",
          pagamenti: Array.isArray(p.pagamenti) ? p.pagamenti : [],
          pacchetto: pacchetti[u.uid] || null,
          sezioniPersonalizzate: Array.isArray(p.sezioniPersonalizzate) ? p.sezioniPersonalizzate : [],
          creato: u.metadata.creationTime || "",
          // L'app tiene aperta la sessione: lastSignInTime è l'ultimo inserimento
          // della password, il profilo l'ultima apertura dell'app. Vale la più recente.
          ultimoAccesso: piuRecente(p.ultimoAccesso, u.metadata.lastSignInTime),
          versioneApp: typeof p.versioneApp === "string" ? p.versioneApp : "",
          programmaInviato: p.programmaInviato && typeof p.programmaInviato === "object" ? p.programmaInviato : null,
          amministratore: u.email === ADMIN_EMAIL,
        };
      }),
    };
  }

  if (azione === "crea") {
    const email = typeof d.email === "string" ? d.email.trim().toLowerCase() : "";
    const nome = typeof d.nome === "string" ? d.nome.trim().slice(0, 120) : "";
    const genere = GENERI.includes(d.genere) ? d.genere : "n";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError("invalid-argument", "Email non valida.");
    if (!nome) throw new HttpsError("invalid-argument", "Inserisci nome e cognome.");
    controllaPassword(d.password);
    let utente;
    try {
      utente = await auth.createUser({ email, password: d.password, displayName: nome });
    } catch (e) {
      if (e.code === "auth/email-already-exists") throw new HttpsError("already-exists", "Esiste già un account con questa email.");
      throw new HttpsError("internal", "Creazione account non riuscita.");
    }
    await db.collection("utenti").doc(utente.uid).set({
      email, nome, genere,
      attivo: true, eliminato: false,
      mustChangePassword: true, // al primo accesso dovrà sceglierne una sua
      demoMode: false,
      piano: "prova", modello: "gineco", sconto: "", scadenza: "", prezzo: 0, noteLicenza: "", pagamenti: [],
      ...campiLicenza(d),
      createdAt: new Date().toISOString(),
      createdBy: request.auth.token.email,
    });
    return { uid: utente.uid };
  }

  if (azione === "modelloDemo") {
    // Modello (specialità) mostrato dal sito dimostrativo pubblico.
    const modello = typeof d.modello === "string" ? d.modello.trim() : "";
    if (!/^[a-z0-9-]{2,30}$/.test(modello)) throw new HttpsError("invalid-argument", "Modello non valido.");
    await db.collection("config").doc("demo").set({ modello, aggiornato: new Date().toISOString(), da: request.auth.token.email });
    return { ok: true };
  }
  if (azione === "leggiModelloDemo") {
    const doc = await db.collection("config").doc("demo").get();
    return { modello: doc.exists ? doc.data().modello : "gineco" };
  }

  if (azione === "leggiPasswordDownload") {
    return statoPasswordDownload(await RIF_PASSWORD_DOWNLOAD().get());
  }
  if (azione === "generaPasswordDownload") {
    // Una sola password valida alla volta: generarne una nuova annulla la precedente.
    const scadenza = typeof d.scadenza === "string" && reData.test(d.scadenza) ? d.scadenza : "";
    await RIF_PASSWORD_DOWNLOAD().set({
      password: nuovaPasswordDownload(), scadenza, creata: new Date().toISOString(),
      da: request.auth.token.email, download: 0, ultimoDownload: null,
    });
    return statoPasswordDownload(await RIF_PASSWORD_DOWNLOAD().get());
  }
  if (azione === "disattivaPasswordDownload") {
    await RIF_PASSWORD_DOWNLOAD().delete();
    return { attiva: false };
  }

  if (!uid) throw new HttpsError("invalid-argument", "Account non specificato.");

  if (azione === "stato") {
    nonSuSeStesso();
    const attivo = d.attivo === true;
    await auth.updateUser(uid, { disabled: !attivo });
    if (!attivo) await auth.revokeRefreshTokens(uid); // scollega subito le sessioni aperte
    await db.collection("utenti").doc(uid).set({ attivo }, { merge: true });
    return { ok: true };
  }

  if (azione === "password") {
    controllaPassword(d.password);
    await auth.updateUser(uid, { password: d.password });
    if (uid !== io) await auth.revokeRefreshTokens(uid);
    await db.collection("utenti").doc(uid).set({ mustChangePassword: uid !== io }, { merge: true });
    return { ok: true };
  }

  if (azione === "aggiorna") {
    const modifiche = {};
    if (typeof d.nome === "string" && d.nome.trim()) modifiche.nome = d.nome.trim().slice(0, 120);
    if (GENERI.includes(d.genere)) modifiche.genere = d.genere;
    if (typeof d.demoMode === "boolean") modifiche.demoMode = d.demoMode;
    if (!Object.keys(modifiche).length) throw new HttpsError("invalid-argument", "Nessuna modifica.");
    if (modifiche.nome) await auth.updateUser(uid, { displayName: modifiche.nome });
    await db.collection("utenti").doc(uid).set(modifiche, { merge: true });
    return { ok: true };
  }

  if (azione === "licenza") {
    // Piano, versione, scadenza e prezzo; facoltativamente registra un pagamento.
    const modifiche = campiLicenza(d);
    const p = d.pagamento;
    if (p && typeof p === "object") {
      const importo = typeof p.importo === "number" ? Math.round(p.importo * 100) / 100 : NaN;
      if (!(importo >= 0 && importo < 100000)) throw new HttpsError("invalid-argument", "Importo non valido.");
      if (!reData.test(p.data || "")) throw new HttpsError("invalid-argument", "Data del pagamento non valida.");
      modifiche.pagamenti = FieldValue.arrayUnion({
        id: Date.now().toString(36),
        data: p.data, importo,
        metodo: METODI.includes(p.metodo) ? p.metodo : "altro",
        fattura: testo(p.fattura, 40),
        nota: testo(p.nota, 200),
        piano: modifiche.piano || "",
      });
    }
    if (!Object.keys(modifiche).length) throw new HttpsError("invalid-argument", "Nessuna modifica.");
    await db.collection("utenti").doc(uid).set(modifiche, { merge: true });
    return { ok: true };
  }

  if (azione === "eliminaPagamento") {
    const ref = db.collection("utenti").doc(uid);
    const doc = await ref.get();
    const lista = (doc.exists && Array.isArray(doc.data().pagamenti)) ? doc.data().pagamenti : [];
    await ref.set({ pagamenti: lista.filter((x) => x.id !== d.idPagamento) }, { merge: true });
    return { ok: true };
  }

  // ── Pacchetto studio: testi propri di un medico (mai dati di pazienti) ──
  // pacchetti/{uid}: { nome, sezioni:{id: {titolo:testo}|[voci]}, consensi:[...], schemi:[...] }
  // Ogni salvataggio conserva la versione precedente in pacchetti/{uid}/versioni.
  if (azione === "leggiPacchetto") {
    const ref = db.collection("pacchetti").doc(uid);
    const [doc, ver] = await Promise.all([ref.get(), ref.collection("versioni").orderBy("salvato", "desc").limit(20).get()]);
    return {
      pacchetto: doc.exists ? doc.data() : null,
      versioni: ver.docs.map((v) => ({ id: v.id, salvato: v.data().salvato, da: v.data().da || "", nome: (v.data().pacchetto || {}).nome || "" })),
    };
  }
  if (azione === "salvaPacchetto") {
    // Il portale non conosce l'ordine delle voci scelto dal medico: lo conserva
    // (per le voci che restano; quelle nuove vanno in fondo nell'app).
    if (d.pacchetto && typeof d.pacchetto === "object" && d.pacchetto.ordine === undefined) {
      const attuale = await db.collection("pacchetti").doc(uid).get();
      if (attuale.exists && attuale.data().ordine) d.pacchetto = { ...d.pacchetto, ordine: attuale.data().ordine };
    }
    const p = pulisciPacchetto(d.pacchetto);
    await salvaPacchetto(uid, p, request.auth.token.email);
    return { ok: true };
  }
  if (azione === "ripristinaVersionePacchetto") {
    const v = await db.collection("pacchetti").doc(uid).collection("versioni").doc(String(d.idVersione || "")).get();
    if (!v.exists) throw new HttpsError("not-found", "Versione non trovata.");
    const p = v.data().pacchetto;
    if (p) await salvaPacchetto(uid, pulisciPacchetto(p), request.auth.token.email);
    else await eliminaPacchetto(uid, request.auth.token.email);
    return { ok: true };
  }
  if (azione === "eliminaPacchetto") {
    await eliminaPacchetto(uid, request.auth.token.email);
    return { ok: true };
  }

  if (azione === "inviaProgramma") {
    // Manda al medico, all'email del suo account, il link per scaricare il
    // programma della sua versione (o di quella scelta nel portale).
    const u = await auth.getUser(uid).catch(() => null);
    if (!u || !u.email) throw new HttpsError("not-found", "Account non trovato.");
    const profiloDoc = await db.collection("utenti").doc(uid).get();
    const p = profiloDoc.exists ? profiloDoc.data() : {};
    const modello = MODELLI.includes(d.modello) ? d.modello : (MODELLI.includes(p.modello) ? p.modello : "gineco");
    const { versione, exe } = await ultimaRelease();
    const file = exe.find((a) => modelloDelFile(a.name) === modello);
    if (!file) throw new HttpsError("not-found", `Nell'ultima versione manca l'installer di ${NOMI_MODELLO[modello]}.`);
    // La password provvisoria va nell'email solo se l'account deve ancora cambiarla.
    const password = typeof d.password === "string" && d.password.length >= 8 && d.password.length <= 128 && p.mustChangePassword === true ? d.password : "";
    const nome = (p.nome || u.displayName || u.email.split("@")[0]).replace(/[\r\n]+/g, " ").slice(0, 120);
    const { testo: corpoTesto, html } = emailProgramma({
      nome, genere: GENERI.includes(p.genere) ? p.genere : "n", email: u.email,
      nomeApp: NOMI_MODELLO[modello], versione, link: file.browser_download_url,
      mb: (file.size / 1048576).toFixed(0), nota: testo(d.nota, 2000), password,
    });
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER.value().trim(), pass: EMAIL_PASS.value().replace(/\s+/g, "") },
    });
    try {
      await transporter.sendMail({
        from: { name: "MED System", address: EMAIL_USER.value().trim() },
        to: u.email,
        replyTo: ADMIN_EMAIL,
        subject: `${NOMI_MODELLO[modello]} ${versione}: il programma da installare`,
        text: corpoTesto,
        html,
      });
    } catch (e) {
      console.warn("Invio programma fallito:", e.message);
      throw new HttpsError("internal", "Invio dell'email non riuscito: " + e.message.slice(0, 160));
    }
    const programmaInviato = { data: new Date().toISOString(), versione, modello, file: file.name, conPassword: !!password };
    await db.collection("utenti").doc(uid).set({ programmaInviato }, { merge: true });
    return { ok: true, email: u.email, ...programmaInviato };
  }

  if (azione === "autorizza") {
    // Account esistente senza profilo (creato a mano dalla console): lo abilita all'app.
    const u = await auth.getUser(uid);
    await db.collection("utenti").doc(uid).set({
      email: u.email || "", nome: u.displayName || (u.email || "").split("@")[0],
      genere: "n", attivo: true, eliminato: false, mustChangePassword: false, demoMode: false,
      createdAt: new Date().toISOString(), createdBy: request.auth.token.email,
    }, { merge: true });
    return { ok: true };
  }

  if (azione === "elimina") {
    nonSuSeStesso();
    await auth.deleteUser(uid);
    await db.collection("utenti").doc(uid).delete();
    await db.recursiveDelete(db.collection("pacchetti").doc(uid)).catch(() => {});
    return { ok: true };
  }

  throw new HttpsError("invalid-argument", "Azione non riconosciuta.");
});

// ═══════════════════════════════════════════════════════════
//  INVIO EMAIL ALLE PAZIENTI (sezione "Email" dell'app)
// ═══════════════════════════════════════════════════════════
const MAX_DESTINATARI = 300;
const LIMITE_EMAIL_GIORNO = 500; // stesso ordine di grandezza del limite giornaliero di Gmail

function risolviPlaceholder(testo, nome) {
  return String(testo || "").split("{{NOME}}").join(nome || "");
}

// ═══════════════════════════════════════════════════════════
//  DOWNLOAD DEL PROGRAMMA DAL SITO DEMO (senza account)
// ═══════════════════════════════════════════════════════════
// Riceve { password } e, se è quella generata nel portale (e non è scaduta),
// restituisce i link agli installer dell'ultima release pubblicata.
// Contro i tentativi a raffica: al massimo 20 password sbagliate all'ora in
// tutto, poi si riprova l'ora successiva.
const MAX_ERRORI_ORA = 20;
exports.scaricaProgrammaDemo = onCall({ region: REGIONE, timeoutSeconds: 30, memory: "256MiB" }, async (request) => {
  const inserita = normalizzaPasswordDownload((request.data || {}).password);
  if (!inserita || inserita.length > 64) throw new HttpsError("invalid-argument", "Scrivi la password.");
  const ora = new Date().toISOString().slice(0, 13); // es. 2026-10-31T16
  const rifErrori = db.collection("contatori").doc("downloadDemo_" + ora);
  const errori = await rifErrori.get();
  if (errori.exists && (errori.data().errori || 0) >= MAX_ERRORI_ORA) {
    throw new HttpsError("resource-exhausted", "Troppi tentativi: riprova tra un'ora.");
  }
  const doc = await RIF_PASSWORD_DOWNLOAD().get();
  const stato = statoPasswordDownload(doc);
  const impronta = (t) => crypto.createHash("sha256").update(t).digest();
  const ok = stato.attiva && crypto.timingSafeEqual(impronta(inserita), impronta(normalizzaPasswordDownload(stato.password)));
  if (!ok) {
    await rifErrori.set({ errori: FieldValue.increment(1) }, { merge: true });
    throw new HttpsError("permission-denied", "Password non valida. Chiedila a chi ti ha presentato MED System.");
  }
  if (stato.scaduta) throw new HttpsError("permission-denied", "Questa password è scaduta. Chiedine una nuova.");
  const { versione, exe } = await ultimaRelease();
  await RIF_PASSWORD_DOWNLOAD().set({ download: FieldValue.increment(1), ultimoDownload: new Date().toISOString() }, { merge: true });
  const ordine = { gineco: 0, proct: 1, base: 2 };
  return {
    versione,
    file: exe.map((a) => ({ modello: modelloDelFile(a.name), nome: NOMI_MODELLO[modelloDelFile(a.name)], file: a.name, url: a.browser_download_url, mb: Math.round(a.size / 1048576) }))
      .sort((a, b) => ordine[a.modello] - ordine[b.modello]),
  };
});

exports.inviaEmail = onCall(
  { secrets: [EMAIL_USER, EMAIL_PASS], region: REGIONE, timeoutSeconds: 300, memory: "256MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Devi aver effettuato l'accesso per inviare email.");
    }
    const uid = request.auth.uid;
    const profilo = await db.collection("utenti").doc(uid).get();
    if (!profilo.exists || profilo.data().attivo === false) {
      throw new HttpsError("permission-denied", "Account non abilitato.");
    }

    const { oggetto, corpo, destinatari, mittente } = request.data || {};
    if (typeof oggetto !== "string" || !oggetto.trim() || oggetto.length > 200) {
      throw new HttpsError("invalid-argument", "Oggetto mancante o troppo lungo.");
    }
    if (typeof corpo !== "string" || !corpo.trim() || corpo.length > 20000) {
      throw new HttpsError("invalid-argument", "Testo dell'email mancante o troppo lungo.");
    }
    if (!Array.isArray(destinatari) || destinatari.length === 0) {
      throw new HttpsError("invalid-argument", "Nessuna destinataria selezionata.");
    }
    if (destinatari.length > MAX_DESTINATARI) {
      throw new HttpsError("invalid-argument", `Troppe destinatarie in un solo invio (massimo ${MAX_DESTINATARI}).`);
    }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const dest = destinatari
      .filter((x) => x && typeof x.email === "string" && emailRe.test(x.email.trim()))
      .map((x) => ({
        pazienteId: typeof x.pazienteId === "string" || typeof x.pazienteId === "number" ? String(x.pazienteId) : "",
        nome: typeof x.nome === "string" ? x.nome.slice(0, 120) : "",
        email: x.email.trim().slice(0, 200),
      }));
    if (!dest.length) {
      throw new HttpsError("invalid-argument", "Nessun indirizzo email valido tra le destinatarie.");
    }

    // Mittente: le email partono dall'account del servizio con il nome del
    // medico; in fondo i suoi dati e l'indirizzo a cui rispondere (Reply-To).
    const m = mittente && typeof mittente === "object" ? mittente : {};
    const unaRiga = (v, max) => (typeof v === "string" ? v.replace(/[\r\n"<>]+/g, " ").trim().slice(0, max) : "");
    const nomeMittente = unaRiga(m.nome, 80) || unaRiga(profilo.data().nome, 80);
    const firma = typeof m.firma === "string"
      ? m.firma.split(/\r?\n/).map((r) => r.trim().slice(0, 200)).filter(Boolean).slice(0, 8).join("\n")
      : "";
    let rispondiA = unaRiga(m.rispondiA, 200);
    if (!emailRe.test(rispondiA)) rispondiA = request.auth.token.email || "";
    const piede = "\n\n--\n" + (firma ? firma + "\n\n" : (nomeMittente ? nomeMittente + "\n\n" : "")) +
      (rispondiA ? `Per rispondere scrivere a: ${rispondiA}\n` : "") +
      "(Questo indirizzo serve solo per l'invio e non legge le risposte.)";

    const oggi = new Date().toISOString().slice(0, 10);
    const usageRef = db.collection("emailUsage").doc(`${uid}_${oggi}`);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(usageRef);
        const n = snap.exists ? (snap.data().count || 0) : 0;
        if (n + dest.length > LIMITE_EMAIL_GIORNO) {
          throw new HttpsError("resource-exhausted", `Limite giornaliero di ${LIMITE_EMAIL_GIORNO} email raggiunto.`);
        }
        tx.set(usageRef, { count: FieldValue.increment(dest.length), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      console.warn("rate-limit email tx fallita:", e.message);
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: EMAIL_USER.value().trim(), pass: EMAIL_PASS.value().replace(/\s+/g, "") },
    });

    const risultati = [];
    for (const x of dest) {
      try {
        await transporter.sendMail({
          from: nomeMittente ? { name: nomeMittente, address: EMAIL_USER.value().trim() } : EMAIL_USER.value().trim(),
          to: x.email,
          ...(rispondiA ? { replyTo: rispondiA } : {}),
          subject: risolviPlaceholder(oggetto, x.nome),
          text: risolviPlaceholder(corpo, x.nome) + piede,
        });
        risultati.push({ pazienteId: x.pazienteId, nome: x.nome, email: x.email, ok: true });
      } catch (e) {
        console.warn("Invio email fallito:", e.message);
        risultati.push({ pazienteId: x.pazienteId, nome: x.nome, email: x.email, ok: false, errore: e.message.slice(0, 200) });
      }
    }

    const inviateOk = risultati.filter((r) => r.ok).length;
    return { inviateOk, inviateErrore: risultati.length - inviateOk, dettagli: risultati };
  }
);
