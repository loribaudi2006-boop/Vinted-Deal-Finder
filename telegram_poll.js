// Ascolta le pressioni dei bottoni inline su Telegram (getUpdates) e agisce:
//   deep:<id>  -> avvia deep_analyze.js in background (1 chiamata Gemini, con tetto)
//   arch:<id>  -> archivia l'annuncio (nessun LLM)
//   msg:<id>   -> genera una bozza di primo messaggio al venditore (nessun LLM)
//
// Gira dentro run_loop.sh insieme a triage/analyze. Usa solo l'API Telegram (gratis).
// Non tocca in alcun modo la ricerca o la pipeline automatica.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');
const { updateQueueItem } = require('./queue_update_item.js');

const config = loadConfig();
const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');
const STATE_PATH = path.join(__dirname, 'data', 'telegram_state.json');
const LOG_PATH = path.join(__dirname, 'logs', `telegram_${new Date().toISOString().slice(0, 10)}.log`);
const WATCHDOG_MS = 90 * 1000;
const MAX_DEEP_PER_RUN = 3;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

const { botToken, chatId } = config.telegram || {};
const API = `https://api.telegram.org/bot${botToken}`;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { offset: 0, initialized: false }; }
}
function saveState(s) {
  withLock(() => atomicWriteJson(STATE_PATH, s));
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 20000,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const e = new Error(`${method} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    e.status = res.status;
    e.tgCode = data.error_code;
    throw e;
  }
  return data.result;
}

async function answer(cbId, text) {
  try { await tg('answerCallbackQuery', { callback_query_id: cbId, text: text || '', show_alert: false }); } catch (e) { log('answerCallbackQuery: ' + e.message); }
}

function findItem(id) {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8')).find(x => String(x.id) === String(id));
  } catch { return null; }
}

function draftSellerMessage(item) {
  return `Bozza — copiala e adattala prima di inviarla al venditore (guarda bene le foto!):\n\n` +
    `«Ciao! L'articolo "${item.title}" e' ancora disponibile? Sarei interessato/a, posso pagare subito tramite Vinted. ` +
    `Un paio di domande: la console e' stata testata e si accende regolarmente? Ci sono difetti oltre a quelli in descrizione? ` +
    `Puoi mandarmi una foto con la console accesa (schermata menu) e una dell'etichetta col numero di serie? Grazie!»`;
}

async function handleCallback(cq, deepBudgetRef) {
  const fromChat = String(cq.message?.chat?.id || '');
  if (fromChat !== String(chatId)) { await answer(cq.id, ''); return; }

  const data = String(cq.data || '');
  const [action, id] = data.split(':');
  const item = id ? findItem(id) : null;

  if (action === 'deep') {
    if (!item) { await answer(cq.id, 'Annuncio non piu\' in coda'); return; }
    if (deepBudgetRef.n >= MAX_DEEP_PER_RUN) { await answer(cq.id, 'Un attimo, ne sto gia\' elaborando altre — ripremi tra poco'); return; }
    deepBudgetRef.n += 1;
    await answer(cq.id, '🔬 Avvio analisi approfondita, arriva tra ~1 minuto...');
    const child = spawn('node', ['deep_analyze.js', String(id)], { cwd: __dirname, detached: true, stdio: 'ignore' });
    child.unref();
    log(`deep_analyze avviato in background per ${id}.`);
  } else if (action === 'arch') {
    if (item) updateQueueItem(id, { archived: true, processed: true });
    await answer(cq.id, '🗄 Archiviato');
    try {
      await tg('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (e) { log('editMessageReplyMarkup: ' + e.message); }
  } else if (action === 'msg') {
    if (!item) { await answer(cq.id, 'Annuncio non piu\' in coda'); return; }
    await answer(cq.id, '💬 Bozza in arrivo');
    try {
      await tg('sendMessage', { chat_id: chatId, text: draftSellerMessage(item), disable_web_page_preview: true });
    } catch (e) { log('sendMessage draft: ' + e.message); }
  } else {
    await answer(cq.id, '');
  }
}

async function main() {
  if (!botToken || botToken.startsWith('INSERISCI') || !chatId) {
    log('Telegram non configurato, salto il poll.');
    return;
  }

  let state = loadState();
  let updates;
  try {
    updates = await tg('getUpdates', { offset: state.offset || 0, timeout: 0, allowed_updates: ['callback_query'] });
  } catch (e) {
    if (e.tgCode === 409) { log('getUpdates 409 (un altro poller attivo?) — salto questo giro.'); return; }
    log('getUpdates fallito: ' + e.message);
    return;
  }

  if (!updates || updates.length === 0) return;

  // Primo avvio: non rispondere a pressioni vecchie di ore, salta solo l'offset in avanti.
  if (!state.initialized) {
    const maxId = Math.max(...updates.map(u => u.update_id));
    saveState({ offset: maxId + 1, initialized: true });
    log(`Primo avvio: salto ${updates.length} update vecchi, offset -> ${maxId + 1}.`);
    return;
  }

  const deepBudgetRef = { n: 0 };
  for (const u of updates) {
    state.offset = u.update_id + 1;
    if (u.callback_query) {
      try { await handleCallback(u.callback_query, deepBudgetRef); }
      catch (e) { log('handleCallback: ' + e.message); }
    }
  }
  saveState(state);
}

const watchdog = setTimeout(() => { log('TIMEOUT poll, esco.'); process.exit(1); }, WATCHDOG_MS);
main()
  .then(() => clearTimeout(watchdog))
  .catch(err => { log('ERRORE FATALE: ' + err.stack); process.exit(1); });
