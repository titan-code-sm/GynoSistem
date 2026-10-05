// ═══════════════════════════════════════════════════════════════════
//  MED System Gineco DESKTOP — collegamento dell'app al database interno
// ═══════════════════════════════════════════════════════════════════
// Caricato SOLO nell'app desktop (Tauri), dopo lo script principale di
// index.html. Sostituisce il livello di archiviazione del browser
// (GS_STORAGE: IndexedDB) con un database SQLite interno — un unico file
// "medsystem-gineco.db" nella cartella dati dell'app — che contiene:
//   · archivio       → l'archivio clinico di ogni medico (JSON)
//   · archivio_storico → versioni salvate in automatico (max 1 all'ora)
//   · allegati       → referti esterni e consensi cartacei (PDF/immagini)
// Tutto il contenuto (archivio, versioni, allegati con i loro nomi) è cifrato
// AES-256-GCM con una chiave casuale custodita da Windows (Gestione credenziali,
// comandi Rust chiave_db_leggi/salva): il file copiato altrove è illeggibile.
// Inoltre: stampe e anteprime si aprono in un pannello dentro l'app (niente
// popup), i link esterni nel browser predefinito di Windows.
(function(){
  'use strict';
  const T = window.__TAURI__;
  if(!T || !T.core){ console.warn('MED System desktop: ambiente Tauri non rilevato, uso archivio del browser'); return; }
  const invoke = T.core.invoke;
  // Un database per versione: medsystem-gineco.db, medsystem-base.db...
  const NOME_DB = 'medsystem-' + (window.GS_MODELLO_APP || 'gineco') + '.db';
  const BASE_WEB = 'https://titan-code-sm.github.io/GynoSistem/';
  const STORICO_OGNI_MS = 60*60*1000;
  const STORICO_MAX = 30;

  document.documentElement.dataset.gsDesktop = '1';

  // ── Cifratura ──
  const PREFISSO = 'enc1:';
  // Una sola richiesta alla volta: due salvataggi simultanei al primo avvio
  // non devono creare due chiavi diverse.
  let _chiaveP = null;
  function chiave(){
    if(!_chiaveP){
      _chiaveP = caricaChiave();
      _chiaveP.catch(()=>{ _chiaveP = null; });
    }
    return _chiaveP;
  }
  async function caricaChiave(){
    let k = await invoke('chiave_db_leggi');
    if(!k){
      // Dati già cifrati ma chiave assente in Windows (es. altro account Windows):
      // NON se ne crea una nuova, che li renderebbe irrecuperabili.
      if(await ciSonoDatiCifrati())
        throw new Error('chiave di cifratura non trovata in Windows. I dati sono intatti ma non leggibili da questo account: ripristina un backup completo.');
      k = gsBufToB64(crypto.getRandomValues(new Uint8Array(32)));
      await invoke('chiave_db_salva', { chiave: k });
      if(await invoke('chiave_db_leggi') !== k) throw new Error('La chiave di cifratura non è stata salvata da Windows');
    }
    return crypto.subtle.importKey('raw', gsB64ToBuf(k), 'AES-GCM', false, ['encrypt','decrypt']);
  }
  async function ciSonoDatiCifrati(){
    const db = await invoke('plugin:sql|load', { db: 'sqlite:' + NOME_DB });
    for(const [tab, col] of [['archivio','json'], ['archivio_storico','json'], ['allegati','meta']]){
      let r = [];
      try{ r = await invoke('plugin:sql|select', { db, query: `SELECT COUNT(*) AS n FROM ${tab} WHERE substr(${col},1,5)=$1`, values: [PREFISSO] }); }
      catch(e){ continue; } // tabella non ancora creata: database nuovo
      if(r[0] && r[0].n > 0) return true;
    }
    return false;
  }
  async function cifra(testo){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, await chiave(), new TextEncoder().encode(testo));
    return PREFISSO + gsBufToB64(iv) + ':' + gsBufToB64(new Uint8Array(ct));
  }
  async function decifra(v){
    if(typeof v !== 'string' || !v.startsWith(PREFISSO)) return v; // dato precedente alla cifratura
    const [ivB64, ctB64] = v.slice(PREFISSO.length).split(':');
    const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: gsB64ToBuf(ivB64) }, await chiave(), gsB64ToBuf(ctB64));
    return new TextDecoder().decode(pt);
  }
  // Cifra i dati salvati prima della cifratura. Ogni valore viene riletto e
  // decifrato per verifica PRIMA di sostituire l'originale in chiaro.
  async function cifraDatiEsistenti(ex, sel){
    const passa = async (tabella, idCol, colonne)=>{
      const righe = await sel(`SELECT ${idCol} AS id, ${colonne.join(', ')} FROM ${tabella}`);
      for(const r of righe){
        for(const c of colonne){
          if(typeof r[c] !== 'string' || r[c].startsWith(PREFISSO)) continue;
          const enc = await cifra(r[c]);
          if(await decifra(enc) !== r[c]) throw new Error('Verifica della cifratura fallita');
          await ex(`UPDATE ${tabella} SET ${c}=$1 WHERE ${idCol}=$2`, [enc, r.id]);
        }
      }
    };
    await passa('archivio', 'chiave', ['json']);
    await passa('archivio_storico', 'id', ['json']);
    await passa('allegati', 'id', ['meta', 'dati']);
  }

  // ── SQLite (tauri-plugin-sql) ──
  let _dbChiave = null, _dbPronto = null;
  function apriDb(){
    if(!_dbPronto){
      _dbPronto = (async()=>{
        _dbChiave = await invoke('plugin:sql|load', { db: 'sqlite:' + NOME_DB });
        const ex = (q, v) => invoke('plugin:sql|execute', { db: _dbChiave, query: q, values: v||[] });
        const sel = (q, v) => invoke('plugin:sql|select', { db: _dbChiave, query: q, values: v||[] });
        await ex('CREATE TABLE IF NOT EXISTS archivio (chiave TEXT PRIMARY KEY, json TEXT NOT NULL, aggiornato TEXT NOT NULL)');
        await ex('CREATE TABLE IF NOT EXISTS archivio_storico (id INTEGER PRIMARY KEY AUTOINCREMENT, chiave TEXT NOT NULL, json TEXT NOT NULL, creato TEXT NOT NULL)');
        await ex('CREATE INDEX IF NOT EXISTS idx_storico_chiave ON archivio_storico(chiave, id)');
        await ex('CREATE TABLE IF NOT EXISTS allegati (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, paziente_id TEXT NOT NULL, meta TEXT NOT NULL, dati TEXT NOT NULL, creato TEXT NOT NULL)');
        await ex('CREATE INDEX IF NOT EXISTS idx_allegati_paz ON allegati(uid, paziente_id)');
        await cifraDatiEsistenti(ex, sel);
      })();
      _dbPronto.catch(e=>{ console.error('Apertura database interno fallita:', e); _dbPronto = null; });
    }
    return _dbPronto;
  }
  async function esegui(query, values){
    await apriDb();
    const r = await invoke('plugin:sql|execute', { db: _dbChiave, query, values: values||[] });
    return Array.isArray(r) ? { righe: r[0], ultimoId: r[1] } : { righe: r?.rowsAffected, ultimoId: r?.lastInsertId };
  }
  async function seleziona(query, values){
    await apriDb();
    return invoke('plugin:sql|select', { db: _dbChiave, query, values: values||[] });
  }
  const uid = () => (typeof gsCurrentUser!=='undefined' && gsCurrentUser) ? gsCurrentUser.uid : 'anon';
  const adesso = () => new Date().toISOString();

  // ── Archivio clinico ──
  async function salvaVersione(chiave, json, forza){
    if(/_demo_/.test(chiave)) return; // la demo non tiene uno storico
    const ult = await seleziona('SELECT creato FROM archivio_storico WHERE chiave=$1 ORDER BY id DESC LIMIT 1', [chiave]);
    if(!forza && ult.length && Date.now()-new Date(ult[0].creato).getTime() < STORICO_OGNI_MS) return;
    await esegui('INSERT INTO archivio_storico (chiave, json, creato) VALUES ($1, $2, $3)', [chiave, await cifra(json), adesso()]);
    await esegui('DELETE FROM archivio_storico WHERE chiave=$1 AND id NOT IN (SELECT id FROM archivio_storico WHERE chiave=$2 ORDER BY id DESC LIMIT ' + STORICO_MAX + ')', [chiave, chiave]);
  }
  GS_STORAGE.archivio = {
    async leggi(chiave){
      const r = await seleziona('SELECT json FROM archivio WHERE chiave=$1', [chiave]);
      return r.length ? await decifra(r[0].json) : null;
    },
    async scrivi(chiave, json){
      await esegui('INSERT INTO archivio (chiave, json, aggiornato) VALUES ($1, $2, $3) ON CONFLICT(chiave) DO UPDATE SET json=excluded.json, aggiornato=excluded.aggiornato', [chiave, await cifra(json), adesso()]);
      try{ await salvaVersione(chiave, json, false); }catch(e){ console.warn('Versione automatica non salvata:', e); }
    }
  };

  // ── Allegati (file salvati dentro il database, in base64) ──
  function blobInBase64(blob){
    return new Promise((resolve, reject)=>{
      const r = new FileReader();
      r.onload = ()=>resolve(String(r.result).split(',')[1] || '');
      r.onerror = ()=>reject(r.error);
      r.readAsDataURL(blob);
    });
  }
  function base64InBlob(b64, tipo){
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: tipo || 'application/octet-stream' });
  }
  GS_STORAGE.allegati = {
    async aggiungi(voce){
      const { blob, ...meta } = voce;
      const dati = await blobInBase64(blob);
      const r = await esegui('INSERT INTO allegati (uid, paziente_id, meta, dati, creato) VALUES ($1, $2, $3, $4, $5)',
        [uid(), String(voce.pazienteId), await cifra(JSON.stringify(meta)), await cifra(dati), adesso()]);
      return r.ultimoId;
    },
    async elenco(pazId){
      const r = await seleziona('SELECT id, meta FROM allegati WHERE uid=$1 AND paziente_id=$2', [uid(), String(pazId)]);
      const out = [];
      for(const x of r) out.push({ ...JSON.parse(await decifra(x.meta)), id: x.id });
      return out;
    },
    async leggi(id){
      const r = await seleziona('SELECT id, meta, dati FROM allegati WHERE id=$1 AND uid=$2', [id, uid()]);
      if(!r.length) return null;
      const meta = JSON.parse(await decifra(r[0].meta));
      return { ...meta, id: r[0].id, blob: base64InBlob(await decifra(r[0].dati), meta.tipo) };
    },
    async elimina(id){
      await esegui('DELETE FROM allegati WHERE id=$1 AND uid=$2', [id, uid()]);
    },
    async tutti(){
      const r = await seleziona('SELECT id, meta, dati FROM allegati WHERE uid=$1 ORDER BY id', [uid()]);
      const out = [];
      for(const x of r){ const meta = JSON.parse(await decifra(x.meta)); out.push({ ...meta, id: x.id, blob: base64InBlob(await decifra(x.dati), meta.tipo) }); }
      return out;
    },
    async svuota(){
      await esegui('DELETE FROM allegati WHERE uid=$1', [uid()]);
    },
    async eliminaPaziente(pazId){
      await esegui('DELETE FROM allegati WHERE uid=$1 AND paziente_id=$2', [uid(), String(pazId)]);
    }
  };

  async function dimensioneDb(){
    const r = await seleziona('SELECT page_count * page_size AS byte FROM pragma_page_count(), pragma_page_size()');
    return r.length ? Number(r[0].byte) : 0;
  }
  async function percorsoDb(){
    try{ return await T.path.join(await T.path.appConfigDir(), NOME_DB); }catch(e){ return NOME_DB; }
  }
  window.renderSpazioAllegati = async function(){
    const el = document.getElementById('allegati-spazio');
    if(!el) return;
    try{ el.textContent = `Database interno di questo PC: ${(await dimensioneDb()/1024/1024).toFixed(1)} MB.`; }
    catch(e){ el.textContent = ''; }
  };

  // ── Pannello interno per stampe e anteprime (al posto dei popup) ──
  const stile = document.createElement('style');
  stile.textContent = `
    .gsd-pannello{position:fixed;inset:0;z-index:100000;display:flex;flex-direction:column;background:rgba(0,0,0,.55);backdrop-filter:blur(4px)}
    .gsd-barra{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--surface,#fff);border-bottom:1px solid var(--separator,#ddd);font-family:var(--font,system-ui)}
    .gsd-titolo{flex:1;font-weight:700;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--label,#1c1c1e)}
    .gsd-barra button{font:inherit;font-weight:600;font-size:.85rem;padding:7px 16px;border-radius:8px;border:1px solid var(--separator,#ddd);background:var(--surface2,#f4f4f6);color:var(--label,#1c1c1e);cursor:pointer}
    .gsd-barra button.gsd-stampa{background:var(--primary,#e91e63);border-color:transparent;color:#fff}
    .gsd-frame{flex:1;width:100%;border:0;background:#fff}`;
  document.head.appendChild(stile);

  function apriPannello(src, titolo){
    const ov = document.createElement('div');
    ov.className = 'gsd-pannello';
    ov.innerHTML = '<div class="gsd-barra"><span class="gsd-titolo"></span>'
      + '<button type="button" class="gsd-stampa">🖨️ Stampa</button>'
      + '<button type="button" class="gsd-chiudi">✕ Chiudi</button></div>'
      + '<iframe class="gsd-frame"></iframe>';
    document.body.appendChild(ov);
    const fr = ov.querySelector('iframe');
    const tit = ov.querySelector('.gsd-titolo');
    tit.textContent = titolo || 'Anteprima';
    const chiudi = ()=>{ ov.remove(); document.removeEventListener('keydown', esc); };
    const esc = e=>{ if(e.key==='Escape') chiudi(); };
    document.addEventListener('keydown', esc);
    const aggancia = ()=>{
      try{ fr.contentWindow.close = chiudi; }catch(e){}
      try{ if(fr.contentDocument && fr.contentDocument.title) tit.textContent = fr.contentDocument.title; }catch(e){}
    };
    fr.addEventListener('load', aggancia);
    ov.querySelector('.gsd-chiudi').onclick = chiudi;
    ov.querySelector('.gsd-stampa').onclick = ()=>{ try{ fr.contentWindow.focus(); fr.contentWindow.print(); }catch(e){ console.warn(e); } };
    if(src) fr.src = src;
    aggancia();
    return fr.contentWindow;
  }

  // Le pagine di stampa fanno window.open('') + document.write: ricevono la
  // finestra del pannello. File (blob:) idem. Link web → browser di Windows.
  window.open = function(url){
    const u = url==null ? '' : String(url).trim();
    if(!u || u==='about:blank' || /^(blob|data):/i.test(u)) return apriPannello(u && u!=='about:blank' ? u : '');
    const assoluto = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : new URL(u, BASE_WEB).href;
    invoke('plugin:opener|open_url', { url: assoluto }).catch(e=>{
      console.warn('Apertura link esterno:', e);
      if(typeof gsToast==='function') gsToast('⚠️ Impossibile aprire il link nel browser','gs-error');
    });
    return { closed:false, close(){}, focus(){} };
  };
  window.gsApriBlob = function(blob){
    const url = URL.createObjectURL(blob);
    apriPannello(url, 'Allegato');
    setTimeout(()=>URL.revokeObjectURL(url), 10*60*1000);
  };

  // ── Archiviazione → scheda "Database interno" ──
  const gsDesktop = window.gsDesktop = {
    // Archivio cifrato con una chiave che non c'è più: i dati NON si cancellano,
    // le tabelle vengono rinominate (…_illeggibile_<data>) e ne nascono di nuove,
    // vuote, così si può ripristinare un backup o ripartire. Se la chiave
    // ricomparisse, i dati messi da parte restano recuperabili dall'assistenza.
    async mettiDaParteIlleggibili(){
      await apriDb();
      const suff = new Date().toISOString().replace(/\D/g,'').slice(0,14);
      await esegui('DROP INDEX IF EXISTS idx_storico_chiave');
      await esegui('DROP INDEX IF EXISTS idx_allegati_paz');
      for(const t of ['archivio','archivio_storico','allegati']) await esegui(`ALTER TABLE ${t} RENAME TO ${t}_illeggibile_${suff}`);
      _dbPronto = null;
      await apriDb(); // ricrea le tabelle vuote
      return suff;
    },
    async aggiornaInfo(){
      const el = document.getElementById('gsd-info'); if(!el) return;
      try{
        const [p, byte] = await Promise.all([percorsoDb(), dimensioneDb()]);
        el.innerHTML = `File: <strong>${_escHtml(p)}</strong><br>Dimensione: ${(byte/1024/1024).toFixed(1)} MB · 🔒 cifrato (AES-256)`;
      }catch(e){ el.textContent = 'Database non ancora disponibile.'; }
    },
    async mostraStorico(){
      const box = document.getElementById('gsd-storico'); if(!box) return;
      if(!gsDbStorageKey){ box.textContent = 'Accedi prima con il tuo account.'; return; }
      const r = await seleziona('SELECT id, creato, length(json) AS dim FROM archivio_storico WHERE chiave=$1 ORDER BY id DESC', [gsDbStorageKey]);
      if(!r.length){ box.innerHTML = '<div style="font-size:.8rem;color:var(--label4)">Nessuna versione salvata finora (ne viene creata una al massimo ogni ora mentre lavori).</div>'; return; }
      box.innerHTML = r.map(v=>`<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--separator);font-size:.82rem">
          <span style="flex:1">${new Date(v.creato).toLocaleString('it-IT')} · ${(v.dim/1024).toFixed(0)} KB</span>
          <button class="btn btn-ghost btn-sm" onclick="gsDesktop.ripristinaVersione(${v.id})">Ripristina</button>
        </div>`).join('');
    },
    async ripristinaVersione(id){
      const r = await seleziona('SELECT json, creato FROM archivio_storico WHERE id=$1 AND chiave=$2', [id, gsDbStorageKey]);
      if(!r.length) return;
      const dati = JSON.parse(await decifra(r[0].json));
      const nPaz = (dati.pazienti||[]).length;
      if(!confirm(`Ripristinare la versione del ${new Date(r[0].creato).toLocaleString('it-IT')} (${nPaz} pazienti)?\n\nLo stato attuale viene prima salvato a sua volta tra le versioni, quindi potrai tornare indietro.`)) return;
      await salvaVersione(gsDbStorageKey, JSON.stringify(DB), true);
      DB = dati;
      if(typeof registraLog==='function') registraLog('backup', 'Ripristinata una versione salvata automaticamente');
      await salvaDBSubito();
      location.reload();
    }
  };
  function iniettaSchedaDatabase(){
    const sec = document.getElementById('sec-backup');
    const col = sec && sec.querySelector('.g2 > div');
    if(!col || document.getElementById('gsd-card')) return;
    const card = document.createElement('div');
    card.className = 'card'; card.id = 'gsd-card'; card.style.marginBottom = '16px';
    card.innerHTML = `<div class="card-header"><div><div class="card-title">🖥️ Database interno</div><div class="card-subtitle">Cartelle cliniche, allegati e consensi in un unico file cifrato su questo PC. Per spostarli usa il backup completo.</div></div></div>
      <div id="gsd-info" style="font-size:.8rem;color:var(--label4);margin-bottom:12px;word-break:break-all">…</div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button class="btn btn-ghost" style="justify-content:flex-start;" onclick="gsDesktop.mostraStorico()">🕘 Versioni salvate automaticamente</button>
      </div>
      <div id="gsd-storico" style="margin-top:12px"></div>`;
    col.insertBefore(card, col.firstChild);
  }
  iniettaSchedaDatabase();
  const navigaOriginale = window.naviga;
  if(typeof navigaOriginale === 'function'){
    window.naviga = function(id){
      const r = navigaOriginale.apply(this, arguments);
      if(id === 'backup'){ iniettaSchedaDatabase(); gsDesktop.aggiornaInfo(); }
      return r;
    };
  }

  apriDb().then(()=>console.info('MED System desktop: database interno pronto (cifrato)')).catch(e=>{
    console.error(e);
    if(typeof gsToast==='function') gsToast('⚠️ Database interno non disponibile: '+(e && e.message || e),'gs-error');
  });
})();
