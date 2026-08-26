// Rileva un possibile guasto silenzioso dello scraper (es. Vinted cambia il markup
// e i selettori smettono di trovare qualsiasi annuncio): se index.js non legge
// NESSUN annuncio grezzo (prima di qualsiasi filtro) per piu' esecuzioni consecutive,
// manda UN avviso Telegram, poi aspetta qualche ora prima di ripetere per non spammare
// se il problema persiste. Zero annunci su un catalogo Vinted e' anomalo: quasi
// certamente vuol dire selettori rotti, non "nessun affare in giro".
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { withLock, atomicWriteJson } = require('./lock.js');

const HEALTH_PATH = path.join(__dirname, 'data', 'health_state.json');
const CONSECUTIVE_THRESHOLD = 5; // ~10 minuti a 2 min/run
const REALERT_AFTER_MS = 6 * 60 * 60 * 1000; // non ripetere l'avviso piu' di una volta ogni 6h

function loadHealth() {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8'));
  } catch {
    return { consecutiveZeroRuns: 0, lastAlertAt: 0 };
  }
}

function sendTelegramSafe(message, log) {
  try {
    execFileSync('node', ['notify.js', message], { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
  } catch (err) {
    if (log) log(`Errore invio Telegram (health): ${err.message}`);
  }
}

function checkScraperHealth(rawItemsFound, log) {
  let shouldAlert = false;
  withLock(() => {
    const state = loadHealth();
    if (rawItemsFound > 0) {
      state.consecutiveZeroRuns = 0;
    } else {
      state.consecutiveZeroRuns = (state.consecutiveZeroRuns || 0) + 1;
      const now = Date.now();
      if (
        state.consecutiveZeroRuns >= CONSECUTIVE_THRESHOLD &&
        now - (state.lastAlertAt || 0) > REALERT_AFTER_MS
      ) {
        shouldAlert = true;
        state.lastAlertAt = now;
      }
    }
    atomicWriteJson(HEALTH_PATH, state);
  });
  if (shouldAlert) {
    sendTelegramSafe(
      `⚠️ Il bot non trova PIU' NESSUN annuncio da ${CONSECUTIVE_THRESHOLD}+ esecuzioni consecutive. Probabile che Vinted abbia cambiato il sito (selettori rotti) - controlla i log.`,
      log
    );
    if (log) log('ALLERTA salute inviata: 0 annunci grezzi per troppe esecuzioni consecutive.');
  }
}

module.exports = { checkScraperHealth };
