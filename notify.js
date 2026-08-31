// Helper CLI per mandare un messaggio Telegram usando la config del progetto.
// Uso: node notify.js "testo del messaggio" ["url foto"] ["track"]
// Se e' passata una foto, la manda come sendPhoto con il testo come didascalia; se il
// testo supera il limite di 1024 caratteri delle didascalie Telegram, manda comunque la
// foto (senza didascalia) seguita dal messaggio completo in un secondo invio, cosi' non
// si perde mai nulla del resoconto.
// Se il 3o argomento e' "track", gli id dei messaggi inviati vengono salvati in
// data/sent_alerts.json, cosi' msg_cleanup.js li puo' cancellare dopo la scadenza.
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');

const config = loadConfig();
const message = process.argv[2];
const photoUrl = process.argv[3] || null;
const track = process.argv[4] === 'track';

const SENT_PATH = path.join(__dirname, 'data', 'sent_alerts.json');

if (!message) {
  console.error('Uso: node notify.js "testo del messaggio" ["url foto"] ["track"]');
  process.exit(1);
}

const { botToken, chatId } = config.telegram;
if (!botToken || botToken.startsWith('INSERISCI')) {
  console.error('Telegram non configurato in config.json');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${botToken}`;
const CAPTION_LIMIT = 1024;

const sentIds = [];

async function sendMessage(text) {
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) throw new Error(`sendMessage ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  if (data.result && data.result.message_id) sentIds.push(data.result.message_id);
}

async function sendPhoto(photo, caption) {
  const body = { chat_id: chatId, photo, parse_mode: 'HTML' };
  if (caption != null) body.caption = caption;
  const res = await fetch(`${API}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  if (data.result && data.result.message_id) sentIds.push(data.result.message_id);
}

async function main() {
  if (!photoUrl) {
    await sendMessage(message);
    return;
  }

  if (message.length <= CAPTION_LIMIT) {
    try {
      await sendPhoto(photoUrl, message);
      return;
    } catch (err) {
      console.error('sendPhoto con didascalia fallita, riprovo senza:', err.message);
    }
  }

  // Foto senza didascalia (o didascalia troppo lunga) + messaggio completo a parte.
  try {
    await sendPhoto(photoUrl, null);
  } catch (err) {
    console.error('sendPhoto fallita, mando solo il testo:', err.message);
  }
  await sendMessage(message);
}

function recordSentForCleanup() {
  if (!track || sentIds.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(SENT_PATH), { recursive: true });
    withLock(() => {
      let store = [];
      try {
        store = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
      } catch {
        store = [];
      }
      if (!Array.isArray(store)) store = [];
      const ts = Date.now();
      for (const id of sentIds) store.push({ id, chat: String(chatId), ts });
      atomicWriteJson(SENT_PATH, store);
    });
  } catch (err) {
    console.error('Non riesco a registrare i messaggi per la cancellazione:', err.message);
  }
}

main()
  .then(() => {
    recordSentForCleanup();
    console.log('Messaggio inviato.');
  })
  .catch(err => {
    console.error('Errore invio Telegram:', err.message);
    process.exit(1);
  });
