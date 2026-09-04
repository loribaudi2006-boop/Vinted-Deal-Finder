// Vinted Deal Finder — Fase 1: filtro grezzo, gratuito, nessuna tecnica di elusione anti-bot.
// Naviga pagine di ricerca pubbliche di Vinted con un browser reale (Chrome installato),
// nessun proxy, nessuno spoofing di identita', nessun bypass CAPTCHA.
// Segnala su Telegram solo i candidati che sembrano affari (prezzo basso + parola-chiave di
// difetto, o prezzo molto sotto il valore tipico di un item riconosciuto).

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');
const stats = require('./stats.js');
const health = require('./health.js');
const staleGuard = require('./queue_stale_guard.js');

const SEEN_PATH = path.join(__dirname, 'data', 'seen.json');
const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');
const QUEUE_PRUNE_DAYS = 4;
const WATCHDOG_MS = 5 * 60 * 1000;
const LOG_PATH = path.join(__dirname, 'logs', `run_${new Date().toISOString().slice(0, 10)}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}


// Il testo (alt dell'immagine) ha il formato:
// "Titolo, Brand: X, Condizioni: Y, 60.00 €, 63.70 €"  (prezzo articolo, poi totale con Protezione Acquisti)
function parsePrices(text) {
  const matches = [...text.matchAll(/(\d{1,4}(?:[.,]\d{2})?)\s*€/g)].map(m =>
    parseFloat(m[1].replace(',', '.'))
  );
  return {
    itemPrice: matches[0] ?? null,
    totalPrice: matches[1] ?? matches[0] ?? null,
  };
}

function extractTitle(text) {
  return text.split(',')[0].trim();
}

function looksLikeAccessoryOnly(title, config) {
  const lower = title.toLowerCase().trim();
  const hasAccessoryWord = (config.accessoryExcludeKeywords || []).some(k => lower.includes(k));
  if (!hasAccessoryWord) return false;
  const hasConsoleIndicator = (config.consoleIndicatorKeywords || []).some(k => lower.includes(k));
  if (hasConsoleIndicator) return false;
  const looksLikeBundle = lower.includes('+') || (config.referenceItems || []).some(ref =>
    ref.keywords.some(k => lower.startsWith(k))
  );
  return !looksLikeBundle;
}

function findReferenceMatch(title, config) {
  if (looksLikeAccessoryOnly(title, config)) return null;
  const lower = title.toLowerCase();
  for (const ref of config.referenceItems) {
    if (ref.keywords.some(k => lower.includes(k))) return ref;
  }
  return null;
}

function findFaultKeyword(text, faultKeywords) {
  const lower = text.toLowerCase();
  return faultKeywords.find(k => lower.includes(k)) || null;
}

// Unisce i nuovi candidati trovati in questo giro dentro il queue.json ATTUALE
// (riletto fresco sotto lock), invece di sovrascrivere con una copia ormai vecchia
// caricata a inizio esecuzione — evita di perdere modifiche fatte nel frattempo
// dallo script di analisi (che puo' girare per diversi minuti).
// Ne approfitta per togliere dalla coda gli item ormai processati e vecchi (>14 giorni):
// senza questo, queue.json crescerebbe all'infinito girando 24/7, rallentando ogni
// lettura/scrittura (fatta ad ogni ciclo, sotto lock).
function mergeNewCandidatesIntoQueue(newCandidates, config) {
  let staleDiscardedCount = 0;
  withLock(() => {
    const current = loadJson(QUEUE_PATH, []);
    const existingIds = new Set(current.map(x => x.id));
    for (const c of newCandidates) {
      if (!existingIds.has(c.id)) current.push(c);
    }
    // Se in coda si sono accumulati candidati (di qualunque stato: non ancora
    // triagiati, o promettenti in attesa dell'analisi definitiva) rimasti fermi
    // troppo a lungo, sono quasi certamente gia' venduti: scartarli subito libera
    // la coda per i nuovi annunci, invece di lasciare che il ritardo si accumuli.
    const staleResult = staleGuard.discardStaleCandidates(current, config);
    staleDiscardedCount = staleResult.discardedCount;
    const cutoff = Date.now() - QUEUE_PRUNE_DAYS * 24 * 60 * 60 * 1000;
    const pruned = staleResult.queue.filter(x => !(x.processed && new Date(x.addedAt).getTime() < cutoff));
    atomicWriteJson(QUEUE_PATH, pruned);
  });
  return staleDiscardedCount;
}

// Stesso principio per seen.json: unisce i nuovi id visti in questo giro dentro
// il file attuale invece di sovrascriverlo con una copia caricata a inizio esecuzione.
function mergeNewSeenIds(newSeenEntries) {
  withLock(() => {
    const current = loadJson(SEEN_PATH, {});
    Object.assign(current, newSeenEntries);
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(current)) {
      if (current[id] < cutoff) delete current[id];
    }
    atomicWriteJson(SEEN_PATH, current);
  });
}

async function scrapeSearch(page, search, config) {
  log(`Apro ricerca "${search.name}": ${search.url}`);
  await page.goto(search.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Chiudi banner cookie se presente (varie possibili label)
  try {
    const consentSelectors = ['button[id*="accept"]', 'button[data-testid*="accept"]'];
    for (const sel of consentSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        break;
      }
    }
  } catch {
    // non bloccante
  }

  await page.waitForSelector('img[data-testid*="--image--img"]', { timeout: 20000 }).catch(() => {});

  const rawItems = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[data-testid*="--image--img"]'));
    const seenIds = new Set();
    const out = [];
    for (const img of imgs) {
      const testid = img.getAttribute('data-testid') || '';
      const m = testid.match(/product-item-id-(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const container = document.querySelector(`[data-testid="product-item-id-${id}"]`);
      const anchor = container ? container.querySelector('a[href*="/items/"]') : null;
      if (!anchor) continue;
      out.push({ id, href: anchor.href, text: img.alt || '', photoUrl: img.src || null });
    }
    return out;
  });

  return rawItems;
}

async function main() {
  const config = loadConfig();
  fs.mkdirSync(path.dirname(SEEN_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

  // Heartbeat giornaliero (riepilogo del giorno prima + pulizia log vecchi): index.js
  // e' lo script piu' frequente e gira sempre, anche di notte, quindi e' il punto giusto
  // per accorgersi che e' scattata la mezzanotte.
  stats.checkDailyRollover(log);

  // Copia locale di "gia' visti", usata solo per decidere cosa saltare in QUESTA
  // esecuzione (letta una volta va bene: il peggio che puo' succedere e' ricontrollare
  // due volte lo stesso annuncio, non e' distruttivo). Il file vero e' aggiornato con
  // un merge sotto lock a fine esecuzione, vedi mergeNewSeenIds.
  const seenSnapshot = loadJson(SEEN_PATH, {});
  const now = Date.now();
  const newSeenEntries = {};

  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    let candidatesFound = 0;
    let totalRawItems = 0;
    const newCandidates = [];

    for (const search of config.searches) {
      let items;
      try {
        items = await scrapeSearch(page, search, config);
      } catch (err) {
        log(`Errore su "${search.name}": ${err.message}`);
        continue;
      }
      totalRawItems += items.length;
      log(`"${search.name}": ${items.length} annunci trovati nella pagina.`);

      for (const item of items) {
        if (seenSnapshot[item.id] || newSeenEntries[item.id]) continue;
        newSeenEntries[item.id] = now;

        const title = extractTitle(item.text);
        const { itemPrice, totalPrice } = parsePrices(item.text);
        if (totalPrice == null) continue;
        if (totalPrice > config.maxBuyPrice) continue;
        const price = itemPrice;

        const fault = findFaultKeyword(item.text, config.faultKeywords);
        const ref = search.useReferencePricing ? findReferenceMatch(title, config) : null;

        let discountRatio = null;
        if (ref) {
          discountRatio = 1 - price / ref.typicalPrice;
        }

        const isGoodDiscount = discountRatio != null && discountRatio >= config.minDiscountRatio;

        if (fault || isGoodDiscount) {
          candidatesFound++;
          const reasonParts = [];
          if (fault) reasonParts.push(`parola chiave: "${fault}"`);
          if (isGoodDiscount) {
            reasonParts.push(
              `prezzo ${Math.round(discountRatio * 100)}% sotto il tipico per ${ref.label} (~${ref.typicalPrice}€)`
            );
          }

          newCandidates.push({
            id: item.id,
            category: search.name,
            title,
            price,
            totalPrice,
            reason: reasonParts.join(' + '),
            url: item.href,
            photoUrl: item.photoUrl || null,
            addedAt: new Date().toISOString(),
            processed: false,
            triaged: false,
          });

          log('CANDIDATO IN CODA: ' + title + ' - ' + price + '€ - ' + item.href);
        }
      }
    }

    mergeNewSeenIds(newSeenEntries);
    const staleDiscardedCount = mergeNewCandidatesIntoQueue(newCandidates, config);
    staleGuard.maybeNotify(staleDiscardedCount, config, log);
    health.checkScraperHealth(totalRawItems, log);
    stats.bumpFound(candidatesFound);
    log(`Fine ciclo. Nuovi candidati aggiunti alla coda: ${candidatesFound}.`);
  } finally {
    await browser.close();
  }
}

// Watchdog: se per qualche motivo (rete impallata, Chrome bloccato) il run supera
// questo tempo, forza l'uscita invece di restare appeso e bloccare i giri successivi
// (il lock su queue.json/seen.json si auto-ripara comunque dopo 20s di stallo, vedi lock.js).
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
