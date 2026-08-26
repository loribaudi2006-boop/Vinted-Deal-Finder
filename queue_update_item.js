// Aggiorna in modo sicuro (lock + scrittura atomica) i campi di UN oggetto in queue.json,
// identificato per id. Usato da triage.js. Non tocca gli altri oggetti.
const fs = require('fs');
const path = require('path');
const { withLock, atomicWriteJson } = require(path.join(__dirname, 'lock.js'));

const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');

function updateQueueItem(id, patch) {
  return withLock(() => {
    let queue;
    try {
      queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
    } catch {
      queue = [];
    }
    const item = queue.find(x => x.id === id);
    if (item) Object.assign(item, patch);
    atomicWriteJson(QUEUE_PATH, queue);
    return !!item;
  });
}

module.exports = { updateQueueItem };
