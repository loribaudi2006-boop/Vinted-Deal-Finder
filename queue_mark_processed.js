// Segna come processed:true gli id specificati in queue.json, in modo sicuro
// (lock + scrittura atomica) rispetto a index.js che scrive nello stesso file.
// Uso: node queue_mark_processed.js <id1> <id2> ...
const fs = require('fs');
const path = require('path');
const { withLock, atomicWriteJson } = require(path.join(__dirname, 'lock.js'));

const QUEUE_PATH = path.join(__dirname, 'data', 'queue.json');
const ids = new Set(process.argv.slice(2));

if (ids.size === 0) {
  console.error('Uso: node queue_mark_processed.js <id1> <id2> ...');
  process.exit(1);
}

withLock(() => {
  let queue;
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch {
    queue = [];
  }
  let count = 0;
  for (const item of queue) {
    if (ids.has(item.id) && !item.processed) {
      item.processed = true;
      count++;
    }
  }
  atomicWriteJson(QUEUE_PATH, queue);
  console.log(`Marcati come processed: ${count}/${ids.size} id trovati e aggiornati.`);
});
