// Fase 2b (alternativa a Claude) — Analisi definitiva SOLO con Gemini + scraping diretto.
// Niente grounding (la chiave usata non ha quota per la ricerca Google integrata, da'
// subito 429): Gemini fa solo il ragionamento testuale (stesso costo/velocita' di
// triage.js), e i prezzi/link dei ricambi vengono letti VERI da Amazon.it con lo stesso
// Chrome/puppeteer gia' usato per Vinted — zero chiamate LLM per quella parte, quindi
// zero token extra e link sempre reali (non inventati da un modello).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { loadConfig } = require('./config_loader.js');
const config = loadConfig();
const { fetchListingWithPage } = require('./fetch_listing_lib.js');
const { searchAmazonPart, amazonSearchUrl } = require('./amazon_search.js');
const { nextApiKey, isConfigured } = require('./gemini_keys.js');
const stats = require('./stats.js');

const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');
const LOG_PATH = path.join(__dirname, 'logs', `analysis_gemini_${new Date().toISOString().slice(0, 10)}.log`);
const MAX_PER_RUN = 8;
const VINTED_FEE_RATIO = 0.10;
const WATCHDOG_MS = 10 * 60 * 1000;

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

function isNightThrottled(pendingCount) {
  const { start, end } = config.nightHours || {};
  if (start == null || end == null) return false;
  const hour = new Date().getHours();
  const isNight = start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
  return isNight && pendingCount < (config.nightMinBatchAnalysis || 0);
}

function pickCandidates(queue) {
  return queue
    .filter(x => x.triageResult === 'promising' && !x.processed)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .slice(0, MAX_PER_RUN);
}

function sendTelegram(message, photoUrl) {
  // "track" -> notify.js registra gli id dei messaggi in data/sent_alerts.json,
  // cosi' msg_cleanup.js puo' cancellarli alla scadenza.
  execFileSync('node', ['notify.js', message, photoUrl || '', 'track'], { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
}

function markProcessed(id) {
  execFileSync('node', ['queue_mark_processed.js', id], { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
}

async function askGeminiAnalysis(item, listingText) {
  const { model } = config.gemini;
  const apiKey = nextApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const prompt = `Sei un assistente che fa l'analisi DEFINITIVA (ma solo testuale, niente ricerca web) di un annuncio Vinted per un piccolo business di rivendita/riparazione di console e videogiochi.

CONTESTO: un primo script (triage.js, Gemini) ha gia' dato una valutazione grezza. Tu affini l'analisi. I prezzi reali dei ricambi verranno cercati DOPO da uno script separato su Amazon.it: tu devi solo dire QUALI pezzi/elementi servono e con quale query di ricerca trovarli, non stimarne il prezzo.

Prezzo di acquisto (gia' con Protezione Acquisti): ${item.totalPrice}€.
Titolo: ${item.title}
Testo della pagina annuncio:
"""
${listingText.slice(0, 2500)}
"""
Valutazione grezza precedente (Gemini, triage): difetto="${item.geminiFault || ''}", possibile prezzo esca=${item.geminiBaitPriceSuspected}, margine grezzo stimato=${item.geminiRoughMargin}€.

Rispondi SOLO con un oggetto JSON valido (nessun testo extra, nessun markdown), con questi campi esatti:
{
  "available": true/false (false SOLO se manca del tutto prezzo E descrizione: annuncio davvero rimosso/venduto),
  "title": "titolo breve dell'oggetto",
  "fault": "problema/difetto riscontrato, o stringa vuota se nessuno",
  "baitPriceSuspected": true/false,
  "repairDifficulty": "Facile" / "Media" / "Difficile" / "" (vuoto se nessun difetto),
  "repairNote": "come si risolve, in una frase (vuoto se nessun difetto)",
  "partsNeeded": [ { "name": "nome breve pezzo/elemento", "searchQuery": "query efficace per trovarlo su Amazon.it", "estimatedPriceEUR": numero (prezzo indicativo realistico del pezzo su Amazon.it in euro, in base alla tua conoscenza — serve come stima di riserva se la ricerca automatica non trova il prezzo) } ] (array vuoto se non serve comprare nulla),
  "resaleEstimate": numero (prezzo di rivendita realistico su Vinted una volta funzionante/completo/in buone condizioni),
  "resaleTitle": "titolo pronto per il nuovo annuncio di rivendita",
  "resaleDescription": "descrizione pronta per il nuovo annuncio di rivendita, italiano, tono da privato, onesta sulle condizioni una volta riparato/completato, senza esagerare"
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

// Se Amazon blocca il runner (succede spesso dagli IP GitHub), dopo il primo blocco
// smettiamo di riprovare per gli altri pezzi dello stesso giro e usiamo subito le stime.
let amazonBlockedThisProcess = false;

async function resolveParts(page, partsNeeded, logPrefix) {
  const resolved = [];
  for (const part of partsNeeded || []) {
    const estimate = typeof part.estimatedPriceEUR === 'number' && part.estimatedPriceEUR > 0
      ? part.estimatedPriceEUR
      : null;
    // Fallback usato quando lo scraping Amazon non da' un risultato: prezzo stimato da
    // Gemini (marcato come stima) + link a una ricerca Amazon.it gia' pronta, cosi' e'
    // comunque a un tap di distanza invece di un "cerca a mano".
    const fallback = {
      name: part.name,
      price: estimate,
      estimated: true,
      url: amazonSearchUrl(part.searchQuery),
      title: null,
    };
    if (amazonBlockedThisProcess) {
      resolved.push(fallback);
      continue;
    }
    try {
      const found = await searchAmazonPart(page, part.searchQuery);
      if (found) {
        resolved.push({ name: part.name, price: found.price, estimated: false, url: found.url, title: found.title });
      } else {
        resolved.push(fallback);
        log(`${logPrefix} nessun risultato Amazon per "${part.searchQuery}" — uso stima ${estimate ?? 'n.d.'}€`);
      }
    } catch (err) {
      if (err.isAmazonBlocked) {
        amazonBlockedThisProcess = true;
        log(`${logPrefix} Amazon blocca il runner — passo alle stime per tutti i pezzi di questo giro`);
      } else {
        log(`${logPrefix} ricerca Amazon "${part.searchQuery}" fallita (${err.message}) — uso stima ${estimate ?? 'n.d.'}€`);
      }
      resolved.push(fallback);
    }
  }
  return resolved;
}

function buildTelegramMessage(item, verdict, parts, margin) {
  const baitLine = verdict.baitPriceSuspected
    ? `\n⚠️ <b>Attenzione, possibile prezzo esca:</b> la descrizione lascia intendere che il venditore accetta offerte/tratta — potrebbe non vendere davvero a ${item.totalPrice}€. Verifica prima di contarci.`
    : '';

  const anyEstimated = parts.some(p => p.estimated);
  const partsLines = parts.length === 0
    ? 'Nessuno'
    : parts
        .map(p => {
          if (p.price != null && !p.estimated) return `- ${p.name} — ${p.price.toFixed(2)}€ — ${p.url}`;
          if (p.price != null && p.estimated) return `- ${p.name} — ~${p.price.toFixed(2)}€ (stima) — ${p.url}`;
          return `- ${p.name} — prezzo da verificare — ${p.url}`;
        })
        .join('\n') + (anyEstimated ? '\n<i>(stime: Amazon ha bloccato la ricerca automatica — i link aprono la ricerca)</i>' : '');

  return `━━━━━━━━━━━━━━━
🎮 <b>${verdict.title}</b>
💰 Acquisto: ${item.totalPrice}€ → Rivendita stimata: ${verdict.resaleEstimate}€ → <b>Margine netto: ~${margin.toFixed(0)}€</b>
🔗 ${item.url}${baitLine}

⚠️ Problema: ${verdict.fault || 'Nessuno / condizioni buone'}
🔧 Riparazione: ${verdict.repairDifficulty ? `${verdict.repairDifficulty}. ${verdict.repairNote}` : 'Non necessaria.'}

🛒 Da comprare:
${partsLines}

📝 Annuncio pronto:
Titolo: ${verdict.resaleTitle}
Descrizione: ${verdict.resaleDescription}
━━━━━━━━━━━━━━━`;
}

async function main() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  if (!config.gemini || !isConfigured()) {
    log('Gemini non configurato in config.json, salto l\'analisi.');
    return;
  }

  const queue = loadQueue();
  const pendingCount = queue.filter(x => x.triageResult === 'promising' && !x.processed).length;

  if (isNightThrottled(pendingCount)) {
    log(`Orario notturno, solo ${pendingCount} promettenti in attesa (< ${config.nightMinBatchAnalysis}): salto questo giro per risparmiare chiamate.`);
    return;
  }

  const candidates = pickCandidates(queue);

  if (candidates.length === 0) {
    log('Nessun candidato promettente da analizzare in questo giro.');
    return;
  }

  log(`Analizzo ${candidates.length} candidati.`);

  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    for (const item of candidates) {
      let listingText = item.listingText;

      if (!listingText || listingText.trim().length < 20) {
        try {
          listingText = await fetchListingWithPage(page, item.url);
        } catch (err) {
          log(`Errore caricamento pagina "${item.title}": ${err.message} — lo lascio in coda, riprovo al prossimo giro.`);
          continue;
        }
      }

      if (!listingText || listingText.trim().length < 20) {
        log(`SCARTATO (pagina non leggibile): ${item.title}`);
        markProcessed(item.id);
        continue;
      }

      let verdict;
      try {
        verdict = await askGeminiAnalysis(item, listingText);
      } catch (err) {
        if (err.isQuotaExceeded) {
          log(`Quota Gemini esaurita, mi fermo qui per questo giro (riprovo al prossimo): ${err.message}`);
          break;
        }
        log(`Errore Gemini su "${item.title}": ${err.message} — lo lascio in coda, riprovo al prossimo giro.`);
        continue;
      }

      if (!verdict.available) {
        log(`SCARTATO (non piu' disponibile): ${item.title}`);
        markProcessed(item.id);
        continue;
      }

      const parts = await resolveParts(page, verdict.partsNeeded, `"${item.title}":`);
      // Prezzo reale se trovato su Amazon, altrimenti la stima di Gemini: includere comunque
      // un costo (anche stimato) tiene il calcolo del margine prudente invece di contare 0.
      const partsCost = parts.reduce((sum, p) => sum + (p.price ?? 0), 0);
      const margin = verdict.resaleEstimate - item.totalPrice - partsCost - verdict.resaleEstimate * VINTED_FEE_RATIO;

      if (margin < config.minMarginEuro) {
        log(`SCARTATO: ${item.title} — margine definitivo ~${margin.toFixed(0)}€`);
        markProcessed(item.id);
        continue;
      }

      const message = buildTelegramMessage(item, verdict, parts, margin);
      try {
        sendTelegram(message, item.photoUrl);
        stats.bumpSent(1);
        log(`INVIATO: ${item.title} — margine definitivo ~${margin.toFixed(0)}€`);
      } catch (err) {
        log(`Errore invio Telegram per "${item.title}": ${err.message}`);
      }

      markProcessed(item.id);
    }
  } finally {
    await browser.close();
  }

  log('Fine analisi.');
}

// Watchdog: vedi index.js per il motivo. Tempo massimo piu' alto perche' ogni run
// puo' processare fino a MAX_PER_RUN item, ciascuno con una chiamata Gemini +
// piu' ricerche Amazon per i ricambi.
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
