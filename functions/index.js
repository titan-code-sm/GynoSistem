/**
 * MED System — Cloud Functions
 *
 * Firebase è usato SOLO per gli account: nessun dato clinico, nessuna
 * anagrafica, nessun appuntamento passa da qui. Due funzioni:
 *
 *  - portaleUtenti: gestione degli account dal portale dell'amministratore
 *    (elenco, creazione, blocco/sblocco, password provvisoria, eliminazione).
 *    Usa l'Admin SDK, quindi agisce davvero sull'account di accesso (un
 *    account bloccato non può più entrare, una password provvisoria sostituisce
 *    quella dimenticata).
 *  - inviaEmail: invio delle email alle pazienti dalla sezione "Email"
 *    dell'app. Non conserva nulla: l'archivio delle email inviate resta
 *    nell'app, sul PC. Su Firestore rimane solo un contatore giornaliero
 *    (numero di email inviate, nessun indirizzo né testo) per il limite anti-abuso.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

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

// ═══════════════════════════════════════════════════════════
//  PORTALE UTENTI (solo amministratore)
// ═══════════════════════════════════════════════════════════
exports.portaleUtenti = onCall({ region: REGIONE, timeoutSeconds: 60, memory: "256MiB" }, async (request) => {
  soloAmministratore(request);
  const d = request.data || {};
  const azione = d.azione;
  const io = request.auth.uid;
  const uid = typeof d.uid === "string" ? d.uid : "";
  const nonSuSeStesso = () => {
    if (uid === io) throw new HttpsError("failed-precondition", "Non puoi eseguire questa operazione sul tuo stesso account.");
  };

  if (azione === "elenco") {
    const [lista, docs] = await Promise.all([auth.listUsers(1000), db.collection("utenti").get()]);
    const profili = {};
    docs.forEach((doc) => { profili[doc.id] = doc.data(); });
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
          creato: u.metadata.creationTime || "",
          ultimoAccesso: u.metadata.lastSignInTime || "",
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
      createdAt: new Date().toISOString(),
      createdBy: request.auth.token.email,
    });
    return { uid: utente.uid };
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

    const { oggetto, corpo, destinatari } = request.data || {};
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
      auth: { user: EMAIL_USER.value().trim(), pass: EMAIL_PASS.value().trim() },
    });

    const risultati = [];
    for (const x of dest) {
      try {
        await transporter.sendMail({
          from: EMAIL_USER.value().trim(),
          to: x.email,
          subject: risolviPlaceholder(oggetto, x.nome),
          text: risolviPlaceholder(corpo, x.nome),
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
