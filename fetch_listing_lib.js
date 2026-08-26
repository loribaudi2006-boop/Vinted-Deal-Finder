// Logica condivisa per leggere una pagina di annuncio Vinted con una tab Chrome gia' aperta.
// Usata sia da fetch_listing.js (CLI, un browser per chiamata) sia da triage.js
// (un browser condiviso per tutto il giro, molto piu' veloce).
async function fetchListingWithPage(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

  const consentBtn = await page.$('button[id*="accept"], button[data-testid*="accept"]');
  if (consentBtn) {
    await consentBtn.click().catch(() => {});
  }

  await page
    .waitForFunction(() => /\d[.,]\d\d\s*€/.test(document.body.innerText), { timeout: 15000 })
    .catch(() => {});

  let text = await page.evaluate(() => document.body.innerText);

  if (!/\d[.,]\d\d\s*€/.test(text)) {
    await new Promise(r => setTimeout(r, 3000));
    text = await page.evaluate(() => document.body.innerText);
  }

  const priceIdx = text.search(/\d[.,]\d\d\s*€/);
  const start = priceIdx >= 0 ? Math.max(0, priceIdx - 300) : 0;
  const trustIdx = text.indexOf('Compra e vendi in tutta sicurezza');
  const end = trustIdx > start ? trustIdx : start + 2200;
  const trimmed = text.slice(start, end).trim();

  return trimmed || text.slice(0, 2200);
}

module.exports = { fetchListingWithPage };
