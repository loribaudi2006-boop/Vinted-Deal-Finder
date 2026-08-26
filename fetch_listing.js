// Legge una pagina di annuncio Vinted con un browser reale (Chrome headless), invece di WebFetch,
// che su queste pagine risulta inaffidabile. Nessun login, nessuna tecnica di elusione anti-bot.
// Uso: node fetch_listing.js <url>
const path = require('path');
const puppeteer = require('puppeteer-core');
const config = require(path.join(__dirname, 'config.json'));
const { fetchListingWithPage } = require('./fetch_listing_lib.js');

const url = process.argv[2];
if (!url) {
  console.error('Uso: node fetch_listing.js <url>');
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: config.chromePath,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const text = await fetchListingWithPage(page, url);
    console.log(text);
  } catch (err) {
    console.error('Errore nel caricamento della pagina: ' + err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
