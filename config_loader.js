// Carica config.json e sovrascrive i segreti (token/chiavi) con le variabili
// d'ambiente in .env, se presenti - cosi' i segreti veri non devono stare nel
// file di config (utile per non pubblicarli per sbaglio quando il progetto
// verra' spostato su una VM/Git). Se .env manca o una variabile non e'
// impostata, resta il valore gia' presente in config.json (compatibilita'
// con l'uso attuale).
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const ENV_PATH = path.join(__dirname, '.env');

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

let cached = null;

function loadConfig() {
  if (cached) return cached;
  loadEnvFile();
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram = config.telegram || {};
    config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  }
  if (process.env.TELEGRAM_CHAT_ID) {
    config.telegram = config.telegram || {};
    config.telegram.chatId = process.env.TELEGRAM_CHAT_ID;
  }

  const envGeminiKeys = Object.keys(process.env)
    .filter(k => /^GEMINI_API_KEY_\d+$/.test(k))
    .sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]))
    .map(k => process.env[k]);
  if (envGeminiKeys.length > 0) {
    config.gemini = config.gemini || {};
    config.gemini.apiKeys = envGeminiKeys;
  }

  // Su GitHub Actions (Linux) il percorso di Chrome e' diverso da quello Windows
  // salvato in config.json: la workflow lo passa come variabile d'ambiente CHROME_PATH.
  if (process.env.CHROME_PATH) {
    config.chromePath = process.env.CHROME_PATH;
  }

  cached = config;
  return config;
}

module.exports = { loadConfig };
