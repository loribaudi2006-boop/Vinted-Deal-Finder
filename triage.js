// Fase 2a — Triage grezzo con Gemini (gratis). Legge i candidati non ancora triagiati,
// apre ogni pagina (fetch_listing.js, locale/gratis), chiede a Gemini una valutazione
// rapida e approssimativa, e scarta subito chi non ha speranza di margine — cosi' la
// fase di analisi definitiva (analyze_gemini.js) lavora solo sui pochi candidati davvero promettenti.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { loadConfig } = require('./config_loader.js');
const config = loadConfig();
const { updateQueueItem } = require('./queue_update_item.js');
const { fetchListingWithPage } = require('./fetch_listing_lib.js');
const { nextApiKey, isConfigured } = require('./gemini_keys.js');

const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');
const LOG_PATH = path.join(__dirname, 'logs', `triage_${new Date().toISOString().slice(0, 10)}.log`);
const MAX_PER_RUN = 15;
const WATCHDOG_MS = 8 * 60 * 1000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function loadQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch {
    return [];
  }
}


async function askGemini(item, listingText) {
  const { model } = config.gemini;
  const apiKey = nextApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `Sei un valutatore rapido di annunci Vinted per un business di rivendita/riparazione di console e videogiochi.
Prezzo di acquisto (gia' con Protezione Acquisti): ${item.totalPrice}€.
Testo della pagina dell'annuncio (letto con un browser vero):
"""
${listingText.slice(0, 2500)}
"""
Nota: nel testo puo' comparire la scritta "Rimosso!" anche su annunci validi (e' un artefatto della pagina, non fidartene). Un annuncio e' davvero rimosso/venduto SOLO se manca del tutto un prezzo E una descrizione.

Rispondi SOLO con un oggetto JSON valido (nessun testo extra, nessun markdown), con questi campi esatti:
{
  "available": true/false (false se l'annuncio risulta davvero rimosso/venduto, vedi sopra),
  "title": "titolo breve dell'oggetto",
  "fault": "descrizione del problema/difetto se presente, altrimenti stringa vuota",
  "baitPriceSuspected": true/false (true se la descrizione fa pensare a un prezzo civetta: 'accetto offerte', 'trattabile', 'prezzo indicativo', o un prezzo assurdamente basso senza alcun difetto che lo giustifichi),
  "roughResaleEstimate": numero (stima approssimativa in euro del prezzo di rivendita realistico su Vinted una volta funzionante/completo),
  "roughMarginEstimate": numero (roughResaleEstimate - ${item.totalPrice} - una stima GENEROSA verso l'alto del costo di eventuali ricambi, per sicurezza - non serve precisione, solo un ordine di grandezza),
  "worthDeepAnalysis": true/false (true SOLO se roughMarginEstimate e' chiaramente e con margine di sicurezza sopra i ${config.minMarginEuro}€, o l'affare e' comunque eccezionale per rapidita' di rivendita)
}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
    if (res.status === 429) err.isQuotaExceeded = true;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Risposta Gemini vuota/inattesa: ' + JSON.stringify(data).slice(0, 300));
  return JSON.parse(text);
}

// Di notte ci sono molti meno annunci nuovi: invece di fare comunque una chiamata
// Gemini ogni pochi minuti per 0-1 candidati, si accumulano finche' non ce ne sono
// abbastanza (o torna il giorno) — stesso risultato, molte meno chiamate API.
function isNightThrottled(untriagedCount) {
  const { start, end } = config.nightHours || {};
  if (start == null || end == null) return false;
  const hour = new Date().getHours();
  const isNight = start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
  return isNight && untriagedCount < (config.nightMinBatchTriage || 0);
}

function pickCandidates(queue) {
  const untriaged = queue.filter(x => !x.triaged);
  const cheap = untriaged
    .filter(x => x.totalPrice <= config.flashAlertMaxPrice)
    .sort((a, b) => a.totalPrice - b.totalPrice);
  const rest = untriaged
    .filter(x => x.totalPrice > config.flashAlertMaxPrice)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  return [...cheap, ...rest].slice(0, MAX_PER_RUN);
}

async function main() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  if (!config.gemini || !isConfigured()) {
    log('Gemini non configurato in config.json, salto il triage.');
    return;
  }

  const queue = loadQueue();
  const untriagedCount = queue.filter(x => !x.triaged).length;

  if (isNightThrottled(untriagedCount)) {
    log(`Orario notturno, solo ${untriagedCount} candidati in attesa (< ${config.nightMinBatchTriage}): salto questo giro per risparmiare chiamate.`);
    return;
  }

  const candidates = pickCandidates(queue);

  if (candidates.length === 0) {
    log('Nessun candidato da triagiare in questo giro.');
    return;
  }

  log(`Triago ${candidates.length} candidati.`);
  let promising = 0;
  let discarded = 0;

  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
  for (const item of candidates) {
    let listingText;
    try {
      listingText = await fetchListingWithPage(page, item.url);
    } catch (err) {
      log(`Errore caricamento pagina "${item.title}": ${err.message} — lascio non triagiato, riprovo al prossimo giro.`);
      continue;
    }

    if (!listingText || listingText.trim().length < 20) {
      updateQueueItem(item.id, { triaged: true, triageResult: 'discard', processed: true });
      discarded++;
      log(`SCARTATO (pagina non leggibile): ${item.title}`);
      continue;
    }

    let verdict;
    try {
      verdict = await askGemini(item, listingText);
    } catch (err) {
      if (err.isQuotaExceeded) {
        log(`Quota Gemini esaurita, mi fermo qui per questo giro (riprovo al prossimo): ${err.message}`);
        break;
      }
      log(`Errore Gemini su "${item.title}": ${err.message} — lascio non triagiato, riprovo al prossimo giro.`);
      continue;
    }

    if (!verdict.available || !verdict.worthDeepAnalysis) {
      updateQueueItem(item.id, {
        triaged: true,
        triageResult: 'discard',
        processed: true,
        triageNote: verdict.available
          ? `margine stimato ~${verdict.roughMarginEstimate}€, sotto soglia`
          : 'non piu\' disponibile',
      });
      discarded++;
      log(`SCARTATO: ${item.title} — ${verdict.available ? 'margine ~' + verdict.roughMarginEstimate + '€' : 'rimosso/venduto'}`);
      continue;
    }

    // Promettente: salva il testo gia' letto (l'analisi finale non dovra' ri-fare fetch_listing) e passa
    // la palla alla fase di analisi definitiva, che manda l'UNICO messaggio Telegram per questo affare
    // (niente piu' avviso lampo separato: l'analisi finale gira ogni 5 minuti, e' gia' rapida).
    updateQueueItem(item.id, {
      triaged: true,
      triageResult: 'promising',
      processed: false,
      listingText: listingText.slice(0, 2500),
      geminiFault: verdict.fault,
      geminiBaitPriceSuspected: verdict.baitPriceSuspected,
      geminiRoughMargin: verdict.roughMarginEstimate,
    });
    promising++;
    log(`PROMETTENTE: ${item.title} — margine grezzo stimato ~${verdict.roughMarginEstimate}€`);
  }
  } finally {
    await browser.close();
  }

  log(`Fine triage. Promettenti: ${promising}, scartati: ${discarded}.`);
}

// Watchdog: vedi index.js per il motivo. Qui il tempo massimo e' piu' alto perche'
// ogni run puo' processare fino a MAX_PER_RUN item, ciascuno con un fetch di pagina
// + una chiamata Gemini.
const watchdog = setTimeout(() => {
  log(`TIMEOUT: run oltre ${WATCHDOG_MS / 1000}s, forzo uscita per non bloccare il prossimo giro.`);
  process.exit(1);
}, WATCHDOG_MS);

main()
  .then(() => clearTimeout(watchdog))
  .catch(err => {
    log('ERRORE FATALE: ' + err.stack);
    process.exit(1);
  });
