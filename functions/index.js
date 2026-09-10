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
 * Nessun dato anagrafico identificativo transita da qui: il client invia solo
 * il testo clinico che l'operatore ha scritto nella visita.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

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
          "x-api-key": ANTHROPIC_API_KEY.value(),
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
