// Lock file semplice per evitare che index.js (ogni 3 min) e lo script di analisi
// (che puo' girare per diversi minuti) si sovrascrivano a vicenda su queue.json/seen.json.
const fs = require('fs');
const path = require('path');

const LOCK_PATH = path.join(__dirname, 'data', '.lock');

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* busy-wait breve, va bene per attese di poche centinaia di ms */
  }
}

function acquireLock(maxWaitMs = 20000) {
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > maxWaitMs) {
        // Lock stale (processo morto senza pulire): forzalo via dopo il timeout.
        try {
          fs.unlinkSync(LOCK_PATH);
        } catch {
          /* ignora */
        }
        continue;
      }
      sleepSync(150 + Math.random() * 150);
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch {
    /* gia' rilasciato, va bene */
  }
}

function withLock(fn) {
  acquireLock();
  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function atomicWriteJson(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

module.exports = { withLock, atomicWriteJson };
