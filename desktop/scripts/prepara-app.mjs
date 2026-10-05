// Prepara la cartella desktop/app (il "frontend" dell'app desktop) a partire
// dalla versione web nella radice del repository:
//  - copia index.html e i file statici (logo, PDF dei consensi, dati demo)
//  - scarica in locale le librerie caricate da CDN (Firebase, html2pdf), così
//    l'app non dipende da quei server per avviarsi
//  - aggiunge desktop-bridge.js, che collega l'app al database interno
// Se lanciato da un tag "desktop-vX.Y.Z" (GitHub Actions) imposta anche la
// versione dell'app.
// Modello (specialità) come primo argomento: "gineco" (predefinito) o "base".
//   node scripts/prepara-app.mjs base
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESK, '..');
const APP = path.join(DESK, 'app');
const VENDOR = path.join(APP, 'vendor');
const CACHE = path.join(DESK, '.vendor-cache');
const MODELLI = ['gineco', 'base'];
const MODELLO = process.argv[2] || 'gineco';
if (!MODELLI.includes(MODELLO)) throw new Error(`Modello sconosciuto: ${MODELLO} (validi: ${MODELLI.join(', ')})`);

await rm(APP, { recursive: true, force: true });
await mkdir(VENDOR, { recursive: true });
await mkdir(CACHE, { recursive: true });

for (const f of ['logo.png', 'logo-medsystem.png', 'logo2.png', 'demo-pazienti.json', 'demo-base.json']) {
  if (existsSync(path.join(ROOT, f))) await cp(path.join(ROOT, f), path.join(APP, f));
}
if (existsSync(path.join(ROOT, 'consensi-pdf'))) {
  await cp(path.join(ROOT, 'consensi-pdf'), path.join(APP, 'consensi-pdf'), { recursive: true });
}
await cp(path.join(DESK, 'bridge', 'desktop-bridge.js'), path.join(APP, 'desktop-bridge.js'));

let html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

// Solo i <script src="https://..."></script> veri della pagina: quelli dentro le
// stringhe JS delle pagine di stampa sono scritti come <\/script> e restano online.
const tagScript = /<script src="(https:\/\/[^"]+\.js)"><\/script>/g;
const urls = [...new Set([...html.matchAll(tagScript)].map(m => m[1]))];
for (const url of urls) {
  const nome = url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9.-]+/g, '_');
  const inCache = path.join(CACHE, nome);
  if (!existsSync(inCache)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Download fallito (${r.status}): ${url}`);
    await writeFile(inCache, Buffer.from(await r.arrayBuffer()));
  }
  await cp(inCache, path.join(VENDOR, nome));
  html = html.split(`<script src="${url}"></script>`).join(`<script src="vendor/${nome}"></script>`);
  console.log(`  libreria locale: vendor/${nome}`);
}

// Il modello va deciso prima che parta lo script dell'app
if (!html.includes('<head>')) throw new Error('index.html senza <head>');
html = html.replace('<head>', `<head>
<script>window.GS_MODELLO_APP='${MODELLO}';</script>`);

const chiusura = '</body>';
const pos = html.lastIndexOf(chiusura);
if (pos < 0) throw new Error('index.html senza </body>');
html = html.slice(0, pos) + '<script src="desktop-bridge.js"></script>\n' + html.slice(pos);
await writeFile(path.join(APP, 'index.html'), html, 'utf8');

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME || '') : '';
const m = tag.match(/^desktop-v(\d+\.\d+\.\d+)$/);
if (m) {
  const confPath = path.join(DESK, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(await readFile(confPath, 'utf8'));
  conf.version = m[1];
  await writeFile(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');
  console.log(`  versione app: ${m[1]}`);
}
console.log(`desktop/app pronta (modello: ${MODELLO}).`);
