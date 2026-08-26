// Alterna tra piu' chiavi API Gemini (config.gemini.apiKeys) per raddoppiare la quota
// giornaliera gratuita disponibile. Lo stato (indice della prossima chiave da usare) e'
// salvato su disco e protetto dallo stesso lock di data/queue.json, cosi' triage.js e
// analyze_gemini.js (processi separati) si alternano correttamente invece di finire
// entrambi sulla stessa chiave.
const fs = require('fs');
const path = require('path');
const { withLock, atomicWriteJson } = require('./lock.js');
const { loadConfig } = require('./config_loader.js');
const config = loadConfig();

const STATE_PATH = path.join(__dirname, 'data', 'gemini_key_state.json');

function getApiKeys() {
  if (Array.isArray(config.gemini.apiKeys) && config.gemini.apiKeys.length > 0) {
    return config.gemini.apiKeys;
  }
  if (config.gemini.apiKey) return [config.gemini.apiKey];
  return [];
}

function isConfigured() {
  return getApiKeys().some(k => k && !k.startsWith('INSERISCI'));
}

function nextApiKey() {
  const keys = getApiKeys();
  if (keys.length === 0) throw new Error('Nessuna Gemini apiKey configurata.');
  if (keys.length === 1) return keys[0];

  return withLock(() => {
    let state = { index: 0 };
    try {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
      // primo utilizzo, va bene partire da 0
    }
    const key = keys[state.index % keys.length];
    atomicWriteJson(STATE_PATH, { index: (state.index + 1) % keys.length });
    return key;
  });
}

module.exports = { nextApiKey, isConfigured };
