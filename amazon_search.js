// Cerca un pezzo di ricambio su Amazon.it con una tab Chrome gia' aperta e restituisce
// il primo risultato NON sponsorizzato con titolo, prezzo reale e link diretto pulito
// (amazon.it/dp/ASIN). Nessuna chiamata LLM: e' scraping puro, quindi costo zero token
// e prezzi/link sempre veri (letti dalla pagina, non stimati da un modello).
async function searchAmazonPart(page, query) {
  const url = 'https://www.amazon.it/s?k=' + encodeURIComponent(query);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 15000 }).catch(() => {});

  const results = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));
    return items.map(el => {
      const sponsored = !!el.querySelector('.puis-sponsored-label-text, [data-component-type="sp-sponsored-result"]');
      const titleEl = el.querySelector('h2 span, h2 a span');
      const priceWhole = el.querySelector('.a-price .a-price-whole');
      const priceFraction = el.querySelector('.a-price .a-price-fraction');
      const asin = el.getAttribute('data-asin');
      return {
        sponsored,
        title: titleEl ? titleEl.textContent.trim() : null,
        priceText: priceWhole ? priceWhole.textContent.replace(/[^\d]/g, '') + '.' + (priceFraction ? priceFraction.textContent.replace(/[^\d]/g, '') : '00') : null,
        asin,
      };
    });
  });

  const best = results.find(r => !r.sponsored && r.title && r.priceText && r.asin);
  if (!best) return null;

  return {
    title: best.title,
    price: parseFloat(best.priceText),
    url: `https://www.amazon.it/dp/${best.asin}`,
  };
}

module.exports = { searchAmazonPart };
