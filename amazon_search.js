// Cerca un pezzo di ricambio su Amazon.it con una tab Chrome gia' aperta e restituisce
// il primo risultato NON sponsorizzato con titolo, prezzo reale e link diretto pulito
// (amazon.it/dp/ASIN). Nessuna chiamata LLM: e' scraping puro, quindi costo zero token
// e prezzi/link sempre veri (letti dalla pagina, non stimati da un modello).
//
// NOTA (2026-08-27): dai runner GitHub Actions (IP da datacenter) Amazon mostra spesso
// prima una pagina di consenso cookie che nasconde la griglia dei risultati. Qui la
// chiudiamo esplicitamente (bottone "Rifiuta"/"Continua") e, se serve, impostiamo il
// cookie di consenso e ricarichiamo. Se nonostante tutto non arrivano risultati, si
// restituisce null con un motivo nei log, cosi' il chiamante puo' ripiegare su una stima.

const CONSENT_SELECTORS = [
  '#sp-cc-rejectall',
  'input[data-cel-widget="sp-cc-rejectall"]',
  '#sp-cc-accept',
  'input[name="accept"]',
  'button[name="glowDoneButton"]',
];

async function dismissConsent(page) {
  for (const sel of CONSENT_SELECTORS) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForNetworkIdle({ timeout: 8000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function readResults(page) {
  await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 6000 }).catch(() => {});
  return page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));
    return items.map((el) => {
      const sponsored = !!el.querySelector('.puis-sponsored-label-text, [data-component-type="sp-sponsored-result"]');
      const titleEl = el.querySelector('h2 span, h2 a span');
      const priceWhole = el.querySelector('.a-price .a-price-whole');
      const priceFraction = el.querySelector('.a-price .a-price-fraction');
      const asin = el.getAttribute('data-asin');
      return {
        sponsored,
        title: titleEl ? titleEl.textContent.trim() : null,
        priceText: priceWhole
          ? priceWhole.textContent.replace(/[^\d]/g, '') + '.' + (priceFraction ? priceFraction.textContent.replace(/[^\d]/g, '') : '00')
          : null,
        asin,
      };
    });
  });
}

async function searchAmazonPart(page, query) {
  // Farsi vedere come un browser desktop reale (UA + lingua): non e' evasione di
  // rilevamento comportamentale, e' solo non presentarsi come un client anonimo.
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8' });

  // Cookie che di solito evitano del tutto l'interstiziale di consenso sui runner "puliti".
  try {
    await page.setCookie(
      { name: 'i18n-prefs', value: 'EUR', domain: '.amazon.it' },
      { name: 'lc-acbit', value: 'it_IT', domain: '.amazon.it' }
    );
  } catch {}

  const url = 'https://www.amazon.it/s?k=' + encodeURIComponent(query) + '&language=it_IT';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

  let results = await readResults(page);

  // Nessun risultato: puo' essere la pagina di consenso cookie (recuperabile) oppure il
  // soft-block/errore che Amazon mostra agli IP da datacenter (non recuperabile qui).
  if (!results.length) {
    const diag = await page.evaluate(() => ({
      title: document.title || '',
      snippet: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 200) : '',
    }));
    const lower = (diag.title + ' ' + diag.snippet).toLowerCase();
    const softBlock =
      lower.includes('ci dispiace') ||
      lower.includes('si è verificato un errore') ||
      lower.includes('elaborare la richiesta') ||
      lower.includes('inserisci i caratteri') ||
      lower.includes('robot check') ||
      lower.includes('automated access');

    if (!softBlock && (await dismissConsent(page))) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      results = await readResults(page);
    }

    if (!results.length) {
      const err = new Error(`Amazon: nessun risultato (pagina: "${diag.title}" | "${diag.snippet}")`);
      if (softBlock) err.isAmazonBlocked = true;
      throw err;
    }
  }

  const best = results.find((r) => !r.sponsored && r.title && r.priceText && r.asin);
  if (!best) return null;

  return {
    title: best.title,
    price: parseFloat(best.priceText),
    url: `https://www.amazon.it/dp/${best.asin}`,
  };
}

// Link a una ricerca Amazon.it gia' pronta (fallback quando lo scraping non trova nulla).
function amazonSearchUrl(query) {
  return 'https://www.amazon.it/s?k=' + encodeURIComponent(query);
}

module.exports = { searchAmazonPart, amazonSearchUrl };
