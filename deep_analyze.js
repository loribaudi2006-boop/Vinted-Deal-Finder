// Analisi APPROFONDITA on-demand — parte solo quando premi "🔍 Approfondisci"
// sotto un avviso Telegram. Uso: node deep_analyze.js <itemId>
//
// Fa (in quest'ordine):
//  1. Tetto giornaliero: max config.deepAnalysis.maxPerDay analisi/giorno. Oltre -> stop, niente Gemini.
//  2. Riapre l'annuncio ADESSO: se venduto/rimosso te lo dice e basta.
//  3. Legge la reputazione del venditore (recensioni, valutazione, iscrizione) - zero LLM.
//  4. Prezzi del VENDUTO su eBay.it + mediana dal database prezzi locale - zero LLM.
//  5. UNA sola chiamata Gemini (testo + qualche foto): rischio truffa, valore di mercato,
//     verdetto COMPRA / VALUTA DI PERSONA / LASCIA, prezzo di rivendita col metodo dei 4 passi.
//  6. Manda il report su Telegram.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');
const config = loadConfig();
const { fetchListingWithPage } = require('./fetch_listing_lib.js');
const { extractSellerInfo, extractListingImages, sellerTrustSummary } = require('./seller_check.js');
const { ebaySoldMedian } = require('./ebay_sold.js');
const priceHistory = require('./price_history.js');
const { nextApiKey, isConfigured } = require('./gemini_keys.js');

const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');
const DEEP_STATE_PATH = path.join(__dirname, 'data', 'deep_state.json');
const LOG_PATH = path.join(__dirname, 'logs', `deep_${new Date().toISOString().slice(0, 10)}.log`);
const WATCHDOG_MS = 3 * 60 * 1000;
const MAX_PER_DAY_DEFAULT = 15;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function todayLocal() {
  return new Date().toLocaleDateString('sv-SE');
}

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')); } catch { return []; }
}

function sendTelegram(message, replyMarkup) {
  const args = ['notify.js', message, ''];
  if (replyMarkup) args.push(JSON.stringify(replyMarkup));
  execFileSync('node', args, { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
}

function reportButtons(itemId) {
  return {
    inline_keyboard: [[
      { text: '💬 Bozza messaggio venditore', callback_data: `msg:${itemId}` },
      { text: '🗄 Archivia', callback_data: `arch:${itemId}` },
    ]],
  };
}

// --- tetto giornaliero -------------------------------------------------------
function checkAndBumpDailyCap() {
  const max = (config.deepAnalysis && config.deepAnalysis.maxPerDay) || MAX_PER_DAY_DEFAULT;
  let allowed = false;
  let count = 0;
  withLock(() => {
    let state = { date: todayLocal(), count: 0 };
    try {
      const s = JSON.parse(fs.readFileSync(DEEP_STATE_PATH, 'utf8'));
      if (s && s.date === todayLocal()) state = s;
    } catch {}
    if (state.count < max) {
      state.count += 1;
      allowed = true;
    }
    count = state.count;
    atomicWriteJson(DEEP_STATE_PATH, state);
  });
  return { allowed, count, max };
}

// --- Gemini (una chiamata, multimodale) ------------------------------------
async function fetchImageAsInlineData(url) {
  try {
    const res = await fetch(url, { timeout: 12000 });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\//.test(type)) return null;
    const buf = await res.buffer();
    if (buf.length > 4 * 1024 * 1024) return null;
    return { mime_type: type, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

function buildPrompt(item, listingText, seller, anchors) {
  const anchorLines = [];
  if (anchors.ebay != null) anchorLines.push(`- eBay.it venduto (mediana ${anchors.ebaySamples} annunci): ${anchors.ebay}€`);
  if (anchors.history != null) anchorLines.push(`- Database prezzi locale Vinted (mediana ${anchors.historySamples} osservazioni): ${anchors.history}€`);
  if (anchors.config != null) anchorLines.push(`- Valore di riferimento configurato: ${anchors.config}€`);
  const anchorText = anchorLines.length ? anchorLines.join('\n') : '- nessuna ancora disponibile, stima in base alla tua conoscenza';

  return `Sei il mio consulente per il reselling di console usate. Analizza QUESTO annuncio Vinted e dammi un verdetto operativo. Rispondi in italiano.

Prezzo d'acquisto (gia' con Protezione Acquisti): ${item.totalPrice}€.
Titolo: ${item.title}

Testo pagina annuncio (letto adesso con un browser vero):
"""
${String(listingText).slice(0, 3000)}
"""

Reputazione venditore (letta dalla pagina): recensioni=${seller.reviews ?? 'n.d.'}, valutazione=${seller.rating ?? 'n.d.'}, iscritto=${seller.joined ?? 'n.d.'}, ultimo accesso=${seller.lastSeen ?? 'n.d.'}, localita'=${seller.location ?? 'n.d.'}.

Ancore di prezzo per il valore di mercato del VENDUTO (modello nudo, funzionante):
${anchorText}

Ti allego alcune FOTO dell'annuncio (se presenti): valutale per capire se sono foto reali del prodotto o immagini prese da internet/screenshot di altri annunci, se la console e' mostrata accesa, e se ci sono incongruenze.

Rispondi SOLO con un oggetto JSON valido (nessun markdown), con questi campi esatti:
{
  "available": true/false (false se l'annuncio risulta venduto/rimosso: manca del tutto prezzo E descrizione),
  "scamRisk": "basso" | "medio" | "alto",
  "scamReasons": "1-2 frasi sul perche' di quel livello di rischio (pagamento fuori Vinted, prezzo assurdo senza motivo, foto non reali, venditore nuovo, descrizione vaga...)",
  "photoAssessment": "1-2 frasi: le foto sembrano reali? console accesa? incongruenze?",
  "marketValueEUR": numero (la TUA stima finale del valore di mercato del venduto per questo modello nudo e funzionante, pesando le ancore qui sopra),
  "faultSummary": "difetto/problema dichiarato, o stringa vuota",
  "repairDifficulty": "Facile" | "Media" | "Difficile" | "",
  "repairNote": "come si risolve, in una frase (vuoto se nessun difetto)",
  "buyVerdict": "COMPRA" | "VALUTA DI PERSONA" | "LASCIA",
  "thingsToCheck": ["cosa verificare nelle foto o chiedere al venditore prima di comprare", "..."],
  "resalePriceListino": numero (prezzo di LISTINO consigliato per la rivendita: parti da marketValueEUR, applica i modificatori del caso, poi x1,12 arrotondato pulito),
  "resaleMin": numero (prezzo minimo sotto cui non scendere in trattativa),
  "marginFast": numero (margine netto stimato in scenario vendita veloce = resaleMin - prezzo acquisto - costo ricambi stimato - 10% commissioni Vinted sul prezzo di vendita),
  "marginFull": numero (margine netto in scenario vendita al prezzo pieno = resalePriceListino - prezzo acquisto - costo ricambi stimato - 10% commissioni),
  "notes": "1-2 frasi finali di sintesi operativa"
}`;
}

async function askGeminiDeep(item, listingText, seller, anchors, images) {
  const { model } = config.gemini;
  const apiKey = nextApiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [{ text: buildPrompt(item, listingText, seller, anchors) }];
  for (const img of images) parts.push({ inline_data: img });

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout: 60000 });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
    if (res.status === 429) err.isQuotaExceeded = true;
    throw err;
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Risposta Gemini vuota: ' + JSON.stringify(data).slice(0, 300));
  return JSON.parse(text);
}

function buildReport(item, v, seller, anchors) {
  const verdictIcon = v.buyVerdict === 'COMPRA' ? '✅' : v.buyVerdict === 'LASCIA' ? '⛔️' : '🟡';
  const riskIcon = v.scamRisk === 'alto' ? '🔴' : v.scamRisk === 'medio' ? '🟠' : '🟢';
  const checks = (v.thingsToCheck || []).map(c => `  • ${c}`).join('\n') || '  • (niente di specifico)';
  const anchorBits = [];
  if (anchors.ebay != null) anchorBits.push(`eBay venduto ~${anchors.ebay}€`);
  if (anchors.history != null) anchorBits.push(`storico Vinted ~${anchors.history}€`);
  if (anchors.config != null) anchorBits.push(`riferimento ~${anchors.config}€`);

  return `🔬 <b>ANALISI APPROFONDITA</b>
🎮 ${item.title}
🔗 ${item.url}

${verdictIcon} <b>Verdetto: ${v.buyVerdict}</b>
${riskIcon} Rischio truffa: <b>${v.scamRisk}</b> — ${v.scamReasons || ''}
📷 Foto: ${v.photoAssessment || 'n.d.'}
👤 Venditore: ${sellerTrustSummary(seller)}

💶 Valore di mercato stimato: <b>~${v.marketValueEUR}€</b>${anchorBits.length ? `\n   (${anchorBits.join(' · ')})` : ''}
🛠 Problema: ${v.faultSummary || 'nessuno dichiarato'}${v.repairDifficulty ? ` — riparazione ${v.repairDifficulty}. ${v.repairNote || ''}` : ''}

💰 Acquisto ${item.totalPrice}€ → rivendita listino ~${v.resalePriceListino}€ (minimo ${v.resaleMin}€)
📈 Margine netto: veloce ~${v.marginFast}€ · pieno ~${v.marginFull}€

🔎 <b>Da verificare PRIMA di comprare:</b>
${checks}

📝 ${v.notes || ''}

<i>Analisi ${anchors.deepCount}/${anchors.deepMax} di oggi. La decisione finale e il contatto col venditore restano a te.</i>`;
}

async function main() {
  const itemId = process.argv[2];
  if (!itemId) {
    console.error('Uso: node deep_analyze.js <itemId>');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  const item = loadQueue().find(x => String(x.id) === String(itemId));
  if (!item) {
    sendTelegram(`🔍 Non trovo piu' quell'annuncio in coda (probabilmente e' stato archiviato o e' passato troppo tempo). Riapri il link e valuta a mano.`);
    return;
  }

  if (!config.gemini || !isConfigured()) {
    sendTelegram('🔍 Gemini non e\' configurato, non posso fare l\'analisi approfondita.');
    return;
  }

  const cap = checkAndBumpDailyCap();
  if (!cap.allowed) {
    sendTelegram(`🔍 Limite giornaliero di analisi approfondite raggiunto (${cap.max}/${cap.max}). Riprova domani — il resto del bot continua a funzionare normalmente.`);
    return;
  }
  log(`Analisi approfondita ${cap.count}/${cap.max} per item ${itemId} (${item.title}).`);

  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    let listingText;
    try {
      listingText = await fetchListingWithPage(page, item.url);
    } catch (err) {
      sendTelegram(`⚠️ Non riesco a riaprire l'annuncio (${err.message}). Riprova o controlla a mano: ${item.url}`);
      return;
    }
    if (!listingText || listingText.trim().length < 20 || !/\d[.,]\d\d\s*€/.test(listingText)) {
      sendTelegram(`⛔️ <b>L'annuncio non e' piu' disponibile</b> (venduto o rimosso).\n🎮 ${item.title}\n\nMeno male che l'hai controllato prima di scrivere. L'ho archiviato.`, null);
      try { execFileSync('node', ['queue_mark_processed.js', String(item.id)], { cwd: __dirname, timeout: 15000 }); } catch {}
      return;
    }

    const seller = await extractSellerInfo(page);
    const images = [];
    for (const u of await extractListingImages(page, 3)) {
      const d = await fetchImageAsInlineData(u);
      if (d) images.push(d);
    }
    log(`Venditore: ${JSON.stringify(seller)}. Foto scaricate: ${images.length}.`);

    // Ancore di prezzo (zero Gemini)
    const label = priceHistory.matchLabel(item.title, config.referenceItems);
    const refItem = (config.referenceItems || []).find(r => r.label === label);
    const anchors = {
      ebay: null, ebaySamples: 0,
      history: null, historySamples: 0,
      config: refItem ? refItem.typicalPrice : null,
      deepCount: cap.count, deepMax: cap.max,
    };
    const hist = priceHistory.medianFor(label);
    if (hist) { anchors.history = hist.median; anchors.historySamples = hist.samples; }

    if (config.deepAnalysis && config.deepAnalysis.ebayEnabled !== false) {
      try {
        const ebayPage = await browser.newPage();
        const q = label ? `${label} console` : item.title.split(/\s+/).slice(0, 5).join(' ');
        const eb = await ebaySoldMedian(ebayPage, q);
        await ebayPage.close().catch(() => {});
        if (eb) { anchors.ebay = eb.median; anchors.ebaySamples = eb.samples; }
      } catch (err) {
        log('eBay non disponibile: ' + err.message);
      }
    }

    // Unica chiamata Gemini (con fallback a testo puro se la parte immagini fallisce)
    let verdict;
    try {
      verdict = await askGeminiDeep(item, listingText, seller, anchors, images);
    } catch (err) {
      if (err.isQuotaExceeded) {
        sendTelegram('🔍 Quota Gemini esaurita per oggi — riprova dopo le 9:00 (reset quota). Il resto del bot continua.');
        return;
      }
      if (images.length) {
        log('Chiamata multimodale fallita, riprovo solo testo: ' + err.message);
        verdict = await askGeminiDeep(item, listingText, seller, anchors, []);
      } else {
        throw err;
      }
    }

    sendTelegram(buildReport(item, verdict, seller, anchors), reportButtons(item.id));
    log(`Report inviato per ${itemId}: ${verdict.buyVerdict}, rischio ${verdict.scamRisk}.`);
  } finally {
    await browser.close().catch(() => {});
  }
}

const watchdog = setTimeout(() => {
  log(`TIMEOUT: analisi oltre ${WATCHDOG_MS / 1000}s, esco.`);
  process.exit(1);
}, WATCHDOG_MS);

main()
  .then(() => clearTimeout(watchdog))
  .catch(err => {
    log('ERRORE: ' + err.stack);
    try {
      execFileSync('node', ['notify.js', `🔍 Errore durante l'analisi approfondita: ${err.message}`, ''], { cwd: __dirname, timeout: 15000 });
    } catch {}
    process.exit(1);
  });
