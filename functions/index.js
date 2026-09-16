/**
 * GynoSystem — Cloud Functions
 *
 * Un'unica funzione "callable": fa da tramite sicuro tra il browser e l'API
 * di Anthropic (Claude). La CHIAVE API non è mai nel codice del sito: vive
 * qui come "secret" di Firebase e non lascia mai il server.
 *
 * Sicurezza:
 *  - richiede un utente autenticato con Firebase Auth (request.auth)
 *  - limite di richieste per utente (anti-abuso)
 *  - tetto massimo di token in uscita per contenere i costi
 *
 * Cosa invia il client (deciso lato app, vedi Impostazioni → Assistente):
 *  - durante la visita: solo il testo clinico scritto dall'operatore, senza
 *    nome/data di nascita/codice fiscale/contatti;
 *  - sulla dashboard (punto della giornata / ripasso casi): anche cognome, nome
 *    ed età delle pazienti in agenda e nei promemoria, mai codice fiscale o
 *    contatti. Scelta esplicita dell'operatore per rendere utile il riepilogo.
 * Questa funzione non ispeziona il contenuto: si limita a inoltrarlo ad Anthropic.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
// Account Gmail dello studio da cui partono le email alle pazienti (sezione
// "Email" dell'app). EMAIL_PASS è una "password per le app" di Google
// (16 caratteri, generata da Account Google → Sicurezza → Verifica in due
// passaggi → Password per le app) — MAI la password vera dell'account.
const EMAIL_USER = defineSecret("EMAIL_USER");
const EMAIL_PASS = defineSecret("EMAIL_PASS");

// Modelli: Haiku per i suggerimenti brevi e frequenti (economico e veloce),
// Sonnet per la chat libera (risposte più elaborate, usata meno spesso).
const MODELLI = {
  suggerimento: "claude-haiku-4-5-20251001",
  chat: "claude-sonnet-5",
};
const MAX_TOKEN = { suggerimento: 350, chat: 1000 };

// Limite giornaliero di richieste per utente (finestra a rotazione semplice).
const LIMITE_RICHIESTE_GIORNO = 300;

exports.assistenteAI = onCall(
  {
    secrets: [ANTHROPIC_API_KEY],
    region: "europe-west1",
    timeoutSeconds: 60,
    memory: "256MiB",
    // cors gestito da onCall; la funzione è callable, non un endpoint aperto
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Devi essere autenticata per usare l'assistente.");
    }
    const uid = request.auth.uid;

    const { messages, system, mode } = request.data || {};
    const modo = mode === "chat" ? "chat" : "suggerimento";

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpsError("invalid-argument", "Nessun messaggio fornito.");
    }
    // Sanifica: solo role user/assistant e content stringa, con un tetto di lunghezza.
    const msgPuliti = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }))
      .slice(-12);
    if (!msgPuliti.length) {
      throw new HttpsError("invalid-argument", "Messaggi non validi.");
    }

    // ── Rate limit per utente ──────────────────────────────
    const oggi = new Date().toISOString().slice(0, 10);
    const ref = db.collection("aiUsage").doc(`${uid}_${oggi}`);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const n = snap.exists ? (snap.data().count || 0) : 0;
        if (n >= LIMITE_RICHIESTE_GIORNO) {
          throw new HttpsError("resource-exhausted", "Limite giornaliero di richieste raggiunto.");
        }
        tx.set(ref, { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      // se Firestore non risponde non blocchiamo la richiesta, ma logghiamo
      console.warn("rate-limit tx fallita:", e.message);
    }

    // ── Chiamata all'API Anthropic ─────────────────────────
    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // .trim(): protegge da spazi o "a capo" finiti nel secret al momento di impostarlo
          "x-api-key": ANTHROPIC_API_KEY.value().trim(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODELLI[modo],
          max_tokens: MAX_TOKEN[modo],
          system: typeof system === "string" ? system.slice(0, 6000) : undefined,
          messages: msgPuliti,
        }),
      });
    } catch (e) {
      console.error("fetch Anthropic fallita:", e.message);
      throw new HttpsError("unavailable", "Assistente non raggiungibile, riprova tra poco.");
    }

    if (!resp.ok) {
      const testo = await resp.text().catch(() => "");
      console.error("Anthropic", resp.status, testo.slice(0, 500));
      if (resp.status === 429) throw new HttpsError("resource-exhausted", "Troppe richieste all'assistente, riprova tra poco.");
      throw new HttpsError("internal", "Errore dell'assistente (" + resp.status + ").");
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    return { text, usage: data.usage || null };
  }
);

// ═══════════════════════════════════════════════════════════
//  INVIO EMAIL ALLE PAZIENTI (sezione "Email" dell'app)
// ═══════════════════════════════════════════════════════════
// Invia una email (con eventuale segnaposto {{NOME}} risolto per ciascuna
// destinataria, stesso meccanismo dei consensi informati) a una lista di
// pazienti, via SMTP Gmail con l'account dello studio. Al termine scrive
// UN documento di riepilogo in emailInviate/ (mai il corpo/oggetto se non
// per l'archivio del medico stesso — resta comunque testo amministrativo,
// non clinico: l'app ricorda al medico di non scrivere dati clinici qui).
const MAX_DESTINATARI = 300;
const LIMITE_EMAIL_GIORNO = 500; // stesso ordine di grandezza del limite giornaliero di Gmail

function risolviPlaceholder(testo, nome) {
  return String(testo || "").split("{{NOME}}").join(nome || "");
}

exports.inviaEmail = onCall(
  {
    secrets: [EMAIL_USER, EMAIL_PASS],
    region: "europe-west1",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Devi essere autenticata per inviare email.");
    }
    const uid = request.auth.uid;

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
      .filter((d) => d && typeof d.email === "string" && emailRe.test(d.email.trim()))
      .map((d) => ({
        pazienteId: typeof d.pazienteId === "string" || typeof d.pazienteId === "number" ? String(d.pazienteId) : "",
        nome: typeof d.nome === "string" ? d.nome.slice(0, 120) : "",
        email: d.email.trim().slice(0, 200),
      }));
    if (!dest.length) {
      throw new HttpsError("invalid-argument", "Nessun indirizzo email valido tra le destinatarie.");
    }

    // ── Limite giornaliero (per medico, conta le email effettivamente da inviare) ──
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
    for (const d of dest) {
      try {
        await transporter.sendMail({
          from: EMAIL_USER.value().trim(),
          to: d.email,
          subject: risolviPlaceholder(oggetto, d.nome),
          text: risolviPlaceholder(corpo, d.nome),
        });
        risultati.push({ pazienteId: d.pazienteId, nome: d.nome, email: d.email, ok: true });
      } catch (e) {
        console.warn("Invio email fallito per", d.email, e.message);
        risultati.push({ pazienteId: d.pazienteId, nome: d.nome, email: d.email, ok: false, errore: e.message.slice(0, 200) });
      }
    }

    const inviateOk = risultati.filter((r) => r.ok).length;
    const inviateErrore = risultati.length - inviateOk;

    try {
      await db.collection("emailInviate").add({
        ownerUid: uid,
        oggetto: oggetto.slice(0, 200),
        corpo: corpo.slice(0, 20000),
        destinatari: risultati,
        totaleDestinatari: risultati.length,
        inviateOk,
        inviateErrore,
        data: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn("Scrittura archivio email fallita:", e.message);
    }

    return { inviateOk, inviateErrore, dettagli: risultati };
  }
);
