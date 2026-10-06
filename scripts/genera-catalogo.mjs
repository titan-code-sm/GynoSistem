// Genera catalogo-pacchetti.json: per ogni modello (gineco, proct, base) le
// sezioni di frasi pronte / testi standard con i testi predefiniti, i consensi
// e gli schemi di prescrizione predefiniti. Il portale utenti lo usa come base
// per preparare il "pacchetto studio" di ogni medico.
//
//   node scripts/genera-catalogo.mjs            -> scrive catalogo-pacchetti.json
//   node scripts/genera-catalogo.mjs --stampa   -> lo stampa soltanto
//
// Va rieseguito quando cambiano i testi predefiniti in index.html.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Estrae il letterale (oggetto/array) che parte dalla prima parentesi dopo `inizio`
function letterale(src, inizio, da = 0) {
  const i = src.indexOf(inizio, da);
  if (i < 0) throw new Error('non trovato: ' + inizio);
  let j = i + inizio.length - 1;
  while (src[j] !== '{' && src[j] !== '[') j++;
  const apre = src[j], chiude = apre === '{' ? '}' : ']';
  let liv = 0, k = j, str = null;
  for (; k < src.length; k++) {
    const c = src[k];
    if (str) {
      if (c === '\\') { k++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '/' && src[k + 1] === '/') { k = src.indexOf('\n', k); continue; }
    if (c === apre) liv++;
    else if (c === chiude && --liv === 0) break;
  }
  return { testo: src.slice(j, k + 1), fine: k + 1 };
}
const valuta = (codice, ctx = {}) => vm.runInNewContext('(' + codice + ')', ctx);
const entita = s => s.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const senzaTag = s => entita(s.replace(/<button[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function leggiSorgente(file = path.join(ROOT, 'index.html')) {
  const html = readFileSync(file, 'utf8');
  // Frasi pronte nel codice (GD e relative estensioni)
  const GD = valuta(letterale(html, 'const GD = {').testo);
  let da = 0;
  for (;;) {
    const i = html.indexOf('Object.assign(GD, {', da);
    if (i < 0) break;
    const l = letterale(html, 'Object.assign(GD, ', i);
    Object.assign(GD, valuta(l.testo));
    da = l.fine;
  }
  const categorie = valuta(letterale(html, 'const FRASI_CATEGORIE=[').testo);
  const consensi = {
    gineco: valuta(letterale(html, 'const CONSENSI_DEFAULT = [').testo),
    base: valuta(letterale(html, 'const CONSENSI_BASE = [').testo),
    proct: valuta(letterale(html, 'const CONSENSI_PROCT = [').testo),
  };
  const schemi = valuta(letterale(html, 'const SCHEMI_PRESCRIZIONI_DEFAULT = [').testo);
  // Tendine "aggiungi testo" delle schede visita (option data-full nell'HTML)
  const pannelli = [['gyno-panels', 'Visita ginecologica', 'gineco'], ['ob-panels', 'Visita ostetrica', 'gineco'], ['eco-panels', 'Ecografia ostetrica', 'gineco'], ['gen-panels', 'Visita', 'base'], ['pr-panels', 'Visita proctologica', 'proct']]
    .map(([id, gruppo, modello]) => ({ pos: html.indexOf(`<div id="${id}"`), gruppo, modello }))
    .filter(p => p.pos >= 0).sort((a, b) => a.pos - b.pos);
  const tendine = [];
  const re = /<select onchange="append(?:GD|OB|Combo)Text\('([\w-]+)',this\.options\[this\.selectedIndex\]\.dataset\.full\|\|''\)">([\s\S]*?)<\/select>/g;
  for (const m of html.matchAll(re)) {
    const opz = [...m[2].matchAll(/<option data-full="([^"]*)">([\s\S]*?)<\/option>/g)];
    if (!opz.length) continue;
    const prima = html.slice(Math.max(0, m.index - 2500), m.index);
    const h4 = [...prima.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/g)].pop();
    const lab = [...prima.matchAll(/<label class="form-label">([\s\S]*?)<\/label>/g)].pop();
    const pann = pannelli.filter(p => p.pos < m.index).pop();
    tendine.push({
      id: 'opz_' + m[1],
      nome: senzaTag(h4 ? h4[1] : lab ? lab[1] : m[1]).replace(/\s*\((selezione multipla)\)\s*$/i, ''),
      gruppo: pann ? pann.gruppo : 'Altro',
      modello: pann ? pann.modello : 'gineco',
      tipo: 'frasi',
      predefinito: Object.fromEntries(opz.map(o => [senzaTag(o[2]), entita(o[1])])),
    });
  }
  return { GD, categorie, consensi, schemi, tendine };
}

export function costruisciCatalogo(s) {
  const out = { generato: new Date().toISOString(), modelli: {} };
  for (const modello of ['gineco', 'proct', 'base']) {
    const sezioni = [
      ...s.categorie.filter(c => c.modello === modello).map(c => ({ id: c.id, nome: c.nome, gruppo: c.gruppo, tipo: c.tipo, predefinito: s.GD[c.id] })),
      ...s.tendine.filter(t => t.modello === modello).map(({ modello: _, ...t }) => t),
    ];
    const consensi = modello === 'gineco'
      ? s.consensi.gineco.filter(c => c.titolo !== 'Inserimento IUD').map(({ pdfUfficiale, ...c }) => c)
      : s.consensi[modello];
    out.modelli[modello] = { sezioni, consensi, schemi: modello === 'gineco' ? s.schemi : [] };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalogo = costruisciCatalogo(leggiSorgente());
  const json = JSON.stringify(catalogo, null, 1);
  if (process.argv.includes('--stampa')) console.log(json);
  else {
    writeFileSync(path.join(ROOT, 'catalogo-pacchetti.json'), json + '\n', 'utf8');
    for (const [m, v] of Object.entries(catalogo.modelli)) console.log(`${m}: ${v.sezioni.length} sezioni, ${v.consensi.length} consensi, ${v.schemi.length} schemi`);
  }
}
