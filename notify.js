// Helper CLI per mandare un messaggio Telegram usando la config del progetto.
// Uso: node notify.js "testo del messaggio" ["url foto"] ["reply_markup JSON"]
// Se e' passata una foto, la manda come sendPhoto con il testo come didascalia; se il
// testo supera il limite di 1024 caratteri delle didascalie Telegram, manda comunque la
// foto (senza didascalia) seguita dal messaggio completo in un secondo invio, cosi' non
// si perde mai nulla del resoconto.
// Il 3o argomento opzionale e' un reply_markup Telegram (bottoni inline) come stringa JSON.
const fetch = require('node-fetch');
const { loadConfig } = require('./config_loader.js');

const config = loadConfig();
const message = process.argv[2];
const photoUrl = process.argv[3] || null;

let replyMarkup = null;
if (process.argv[4]) {
  try {
    replyMarkup = JSON.parse(process.argv[4]);
  } catch {
    console.error('reply_markup JSON non valido, lo ignoro.');
  }
}

if (!message) {
  console.error('Uso: node notify.js "testo del messaggio" ["url foto"]');
  process.exit(1);
}

const { botToken, chatId } = config.telegram;
if (!botToken || botToken.startsWith('INSERISCI')) {
  console.error('Telegram non configurato in config.json');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${botToken}`;
const CAPTION_LIMIT = 1024;

async function sendMessage(text) {
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) throw new Error(`sendMessage ${res.status}: ${await res.text()}`);
}

async function sendPhoto(photo, caption, withMarkup = true) {
  const body = { chat_id: chatId, photo, parse_mode: 'HTML' };
  if (caption != null) body.caption = caption;
  if (replyMarkup && withMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`${API}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sendPhoto ${res.status}: ${await res.text()}`);
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
  // I bottoni vanno sul messaggio di testo finale, non sulla foto.
  try {
    await sendPhoto(photoUrl, null, false);
  } catch (err) {
    console.error('sendPhoto fallita, mando solo il testo:', err.message);
  }
  await sendMessage(message);
}

main()
  .then(() => console.log('Messaggio inviato.'))
  .catch(err => {
    console.error('Errore invio Telegram:', err.message);
    process.exit(1);
  });
