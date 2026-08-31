// Database prezzi che si costruisce da solo. Ad ogni giro, index.js gli passa gli
// annunci NUOVI gia' scaricati (nessuna richiesta extra a Vinted): qui, per quelli
// che corrispondono a un modello noto (config.referenceItems), salviamo prezzo + data.
// Dopo qualche settimana abbiamo la mediana reale del mercato, calcolata sui dati veri
// del nostro mercato invece che sui valori scritti a mano in config.json.
// Zero chiamate LLM: solo parsing di testo e matematica.
const fs = require('fs');
const path = require('path');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');

const STORE_PATH = path.join(__dirname, 'data', 'price_history.json');
const RETENTION_DAYS = 45;
const MEDIAN_WINDOW_DAYS = 30;

function loadStore() {
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(s.entries) ? s : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

// Stesso formato testo usato da index.js: "Titolo, Brand: X, ..., 60.00 €, 63.70 €"
function parseFirstPrice(text) {
  const m = String(text || '').match(/(\d{1,4}(?:[.,]\d{2})?)\s*€/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

function matchLabel(title, referenceItems) {
  const lower = String(title || '').toLowerCase();
  for (const ref of referenceItems || []) {
    if ((ref.keywords || []).some(k => lower.includes(k))) return ref.label;
  }
  return null;
}

// Scarta accessori/pezzi (cover, controller, cavi...) che altrimenti inquinerebbero
// la mediana: se il titolo contiene una parola-accessorio e NESSUN indicatore di
// console completa, non e' un prezzo di console.
function looksLikeAccessory(title, config) {
  const lower = String(title || '').toLowerCase();
  const hasAccessory = (config.accessoryExcludeKeywords || []).some(k => lower.includes(k));
  if (!hasAccessory) return false;
  const hasConsole = (config.consoleIndicatorKeywords || []).some(k => lower.includes(k));
  return !hasConsole;
}

// batch = [{ id, text }]  (annunci visti per la prima volta in questo giro)
function recordBatch(batch) {
  if (!batch || batch.length === 0) return;
  const config = loadConfig();
  const refs = config.referenceItems || [];
  const now = Date.now();

  const rows = [];
  for (const it of batch) {
    const title = String(it.text || '').split(',')[0].trim();
    const label = matchLabel(title, refs);
    if (!label) continue;
    if (looksLikeAccessory(title, config)) continue;
    const price = parseFirstPrice(it.text);
    if (price == null || price <= 0) continue;
    rows.push({ t: now, label, price, id: String(it.id) });
  }
  if (rows.length === 0) return;

  withLock(() => {
    const store = loadStore();
    const seenIds = new Set(store.entries.map(e => e.id));
    for (const r of rows) {
      if (!seenIds.has(r.id)) {
        store.entries.push(r);
        seenIds.add(r.id);
      }
    }
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    store.entries = store.entries.filter(e => e.t >= cutoff);
    atomicWriteJson(STORE_PATH, store);
  });
}

// Mediana robusta (scarta il 10% piu' alto e piu' basso) degli ultimi 30 giorni.
// Ritorna null se ci sono pochi dati (< 5) — in quel caso il chiamante usa la stima.
function medianFor(label) {
  const store = loadStore();
  const cutoff = Date.now() - MEDIAN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const prices = store.entries
    .filter(e => e.label === label && e.t >= cutoff)
    .map(e => e.price)
    .sort((a, b) => a - b);
  if (prices.length < 5) return null;
  const drop = Math.floor(prices.length * 0.1);
  const core = prices.slice(drop, prices.length - drop);
  const mid = Math.floor(core.length / 2);
  const median = core.length % 2 ? core[mid] : (core[mid - 1] + core[mid]) / 2;
  return { median: Math.round(median), samples: prices.length };
}

module.exports = { recordBatch, medianFor, matchLabel };
