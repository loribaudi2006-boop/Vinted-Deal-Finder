// Se la coda si intasa (troppi candidati per la capacita' di triage/analisi del
// momento), gli annunci rimasti in attesa per troppo tempo sono quasi certamente
// gia' venduti: tenerli in coda serve solo a rallentare quelli nuovi, che sono gli
// unici per cui vale la pena spendere una chiamata Gemini. Questo modulo li scarta
// (qualunque sia il loro stato: non ancora triagiati, o gia' promettenti ma in
// attesa dell'analisi definitiva) appena superano maxCandidateAgeMinutes, cosi'
// il bot si "auto-arginato" da solo invece di accumulare ritardo all'infinito.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STALE_STATE_PATH = path.join(__dirname, 'data', 'stale_guard_state.json');
const DEFAULT_MAX_AGE_MINUTES = 30;
const REALERT_AFTER_MS = 60 * 60 * 1000; // al massimo un avviso Telegram ogni ora

// Va chiamata SOTTO LOCK su queue.json (chi la chiama gestisce gia' il lock, vedi
// index.js). Pura rispetto al filesystem: prende la coda in memoria e la ritorna
// aggiornata, non scrive nulla lei stessa.
function discardStaleCandidates(queue, config) {
  const maxAgeMinutes = config.maxCandidateAgeMinutes || DEFAULT_MAX_AGE_MINUTES;
  const maxAgeMs = maxAgeMinutes * 60 * 1000;
  const now = Date.now();
  let discardedCount = 0;

  const updated = queue.map(item => {
    if (item.processed) return item;
    if (now - new Date(item.addedAt).getTime() <= maxAgeMs) return item;
    discardedCount++;
    return {
      ...item,
      processed: true,
      triaged: true,
      // Se era gia' stato valutato (es. "promising", in attesa di analisi
      // definitiva) teniamo il verdetto originale per le statistiche; se non
      // era mai stato toccato lo marchiamo come scartato.
      triageResult: item.triageResult || 'discard',
      staleDiscarded: true,
      staleDiscardNote: `scartato dallo stale guard: in coda da oltre ${maxAgeMinutes} min, probabile gia' venduto (priorita' ai nuovi annunci)`,
    };
  });

  return { queue: updated, discardedCount };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STALE_STATE_PATH, 'utf8'));
  } catch {
    return { lastAlertAt: 0 };
  }
}

function sendTelegramSafe(message, log) {
  try {
    execFileSync('node', ['notify.js', message], { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
  } catch (err) {
    if (log) log(`Errore invio Telegram (stale guard): ${err.message}`);
  }
}

// Da chiamare FUORI dal lock su queue.json (fa I/O di rete verso Telegram):
// avvisa al massimo una volta ogni REALERT_AFTER_MS, cosi' se il ritardo persiste
// per ore non spamma un messaggio a ogni giro da 60s.
function maybeNotify(discardedCount, config, log) {
  if (discardedCount <= 0) return;
  const maxAgeMinutes = config.maxCandidateAgeMinutes || DEFAULT_MAX_AGE_MINUTES;
  log(`STALE GUARD: scartati ${discardedCount} candidati troppo vecchi (coda in ritardo), priorita' ai nuovi annunci.`);

  const now = Date.now();
  const state = loadState();
  if (now - (state.lastAlertAt || 0) <= REALERT_AFTER_MS) return;

  try {
    fs.mkdirSync(path.dirname(STALE_STATE_PATH), { recursive: true });
    fs.writeFileSync(STALE_STATE_PATH, JSON.stringify({ lastAlertAt: now }, null, 2));
  } catch (err) {
    log(`Errore salvataggio stato stale guard: ${err.message}`);
  }

  sendTelegramSafe(
    `⏱️ Il bot era in ritardo: ho scartato ${discardedCount} annunci rimasti in coda da oltre ${maxAgeMinutes} min (probabilmente già venduti) per dare priorità a quelli nuovi. Se il ritardo continua a ripresentarsi spesso, potrebbe servire una controllata.`,
    log
  );
}

module.exports = { discardStaleCandidates, maybeNotify };
