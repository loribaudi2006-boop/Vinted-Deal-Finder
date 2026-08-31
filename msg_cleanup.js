// Cancella gli avvisi Telegram inviati dal bot quando superano la scadenza, per
// tenere leggera la chat. Gira dentro run_loop.sh insieme a triage/analyze.
//
// LIMITE TELEGRAM: un bot puo' cancellare i propri messaggi in chat privata SOLO
// entro 48 ore dall'invio. Oltre non e' piu' possibile. Per questo la scadenza di
// default (config.alertRetentionHours) e' 46 ore, poco meno di 2 giorni.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');

const config = loadConfig();
const SENT_PATH = path.join(__dirname, 'data', 'sent_alerts.json');
const LOG_PATH = path.join(__dirname, 'logs', `cleanup_${new Date().toISOString().slice(0, 10)}.log`);

const DEFAULT_RETENTION_H = 46;
const TELEGRAM_HARD_LIMIT_H = 47.5; // oltre questo Telegram rifiuta comunque la cancellazione

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

async function main() {
  const { botToken, chatId } = config.telegram || {};
  if (!botToken || botToken.startsWith('INSERISCI')) return;
  const API = `https://api.telegram.org/bot${botToken}`;

  let store;
  try {
    store = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
  } catch {
    return; // niente da fare
  }
  if (!Array.isArray(store) || store.length === 0) return;

  const retentionH = config.alertRetentionHours || DEFAULT_RETENTION_H;
  const now = Date.now();
  const dueBefore = now - retentionH * 3600 * 1000;
  const undeletableBefore = now - TELEGRAM_HARD_LIMIT_H * 3600 * 1000;

  const keep = [];
  let done = 0;

  for (const m of store) {
    if (!m || !m.id || m.ts > dueBefore) {
      if (m && m.id) keep.push(m);
      continue;
    }

    let removed = false;
    try {
      const res = await fetch(`${API}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: m.chat || chatId, message_id: m.id }),
        timeout: 15000,
      });
      const data = await res.json().catch(() => ({}));
      const desc = (data.description || '').toLowerCase();
      // ok = cancellato; "not found" / "can't be deleted" = gia' sparito o non piu' cancellabile: comunque chiuso
      if (data.ok || desc.includes('not found') || desc.includes("can't be deleted")) {
        removed = true;
      }
    } catch (err) {
      log(`deleteMessage ${m.id}: errore di rete (${err.message}), riprovo al prossimo giro`);
    }

    if (removed) {
      done++;
    } else if (m.ts < undeletableBefore) {
      done++; // troppo vecchio: Telegram non lo cancellera' mai, smetto di riprovare
    } else {
      keep.push(m); // riprova al prossimo giro
    }
  }

  withLock(() => atomicWriteJson(SENT_PATH, keep));
  if (done) log(`${done} avvisi Telegram cancellati/scaduti, ${keep.length} ancora in attesa.`);
}

main().catch(err => {
  log('ERRORE: ' + err.stack);
  process.exit(1);
});
