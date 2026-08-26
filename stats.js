// Contatori giornalieri (candidati trovati / affari inviati) + heartbeat.
// Ogni run di index.js (il piu' frequente, gira comunque anche di notte) controlla
// a inizio esecuzione se e' iniziato un nuovo giorno: se si', manda un riepilogo
// del giorno appena concluso su Telegram, pulisce i log vecchi e resetta i contatori.
// Serve a sapere passivamente che il bot e' vivo senza dover controllare i log a mano
// (utile una volta spostato su una macchina remota).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { withLock, atomicWriteJson } = require('./lock.js');

const STATS_PATH = path.join(__dirname, 'data', 'stats.json');
const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_RETENTION_DAYS = 14;

function todayLocal() {
  return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in ora locale
}

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch {
    return { date: todayLocal(), found: 0, sent: 0 };
  }
}

function cleanOldLogs(log) {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let files;
  try {
    files = fs.readdirSync(LOGS_DIR);
  } catch {
    return;
  }
  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        if (log) log(`Log vecchio rimosso: ${file}`);
      }
    } catch {
      /* ignora, non bloccante */
    }
  }
}

function sendTelegramSafe(message, log) {
  try {
    execFileSync('node', ['notify.js', message], { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
  } catch (err) {
    if (log) log(`Errore invio Telegram (stats): ${err.message}`);
  }
}

// Da chiamare a inizio run di index.js, PRIMA di bumpFound.
function checkDailyRollover(log) {
  let previous = null;
  withLock(() => {
    const stats = loadStats();
    const today = todayLocal();
    if (stats.date !== today) {
      previous = stats;
      atomicWriteJson(STATS_PATH, { date: today, found: 0, sent: 0 });
    }
  });
  if (previous) {
    sendTelegramSafe(
      `🤖 Riepilogo ${previous.date}: ${previous.found || 0} candidati trovati, ${previous.sent || 0} affari inviati.\nIl bot e' attivo e funzionante.`,
      log
    );
    cleanOldLogs(log);
  }
}

function bumpFound(n) {
  if (!n) return;
  withLock(() => {
    const stats = loadStats();
    stats.found = (stats.found || 0) + n;
    atomicWriteJson(STATS_PATH, stats);
  });
}

function bumpSent(n = 1) {
  withLock(() => {
    const stats = loadStats();
    stats.sent = (stats.sent || 0) + n;
    atomicWriteJson(STATS_PATH, stats);
  });
}

module.exports = { checkDailyRollover, bumpFound, bumpSent };
