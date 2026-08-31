// Legge i prezzi del VENDUTO su eBay.it per un modello di console — l'ancora di
// prezzo piu' solida perche' eBay, a differenza di Vinted, mostra pubblicamente a
// quanto le cose si sono vendute davvero. Zero LLM: scraping + mediana in JS.
// Usa una tab Chrome gia' aperta. Se eBay blocca/non da' risultati -> ritorna null,
// il chiamante ripiega su price_history / stima.

function parsePricesFromText(text) {
  // eBay.it mostra "EUR 129,00" oppure "129,00 EUR" o "129,00 €"
  const out = [];
  const re = /(?:EUR\s*)?(\d{1,4}(?:[.,]\d{3})?(?:[.,]\d{2})?)\s*(?:EUR|€)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let raw = m[1];
    // normalizza "1.299,00" / "129,00" -> 129.00
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    const v = parseFloat(raw);
    if (!isNaN(v) && v >= 15 && v <= 900) out.push(v);
  }
  return out;
}

async function ebaySoldMedian(page, query) {
  const url =
    'https://www.ebay.it/sch/i.html?_nkw=' +
    encodeURIComponent(query) +
    '&LH_Sold=1&LH_Complete=1&_sop=13'; // venduti + conclusi, piu' recenti prima

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'it-IT,it;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // banner cookie
    const consent = await page.$('#gdpr-banner-accept, button[aria-label*="Accett"], .gdpr-banner-accept').catch(() => null);
    if (consent) await consent.click().catch(() => {});

    const prices = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('li.s-item, .s-item'));
      const vals = [];
      for (const el of items.slice(0, 40)) {
        const p = el.querySelector('.s-item__price');
        if (p) vals.push(p.textContent.trim());
      }
      return vals;
    });

    let nums = [];
    for (const p of prices) nums.push(...parsePricesFromText(p));
    if (nums.length < 4) {
      // fallback: cerca i prezzi nel testo grezzo della pagina
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 20000));
      nums = parsePricesFromText(bodyText);
    }
    if (nums.length < 4) return null;

    nums.sort((a, b) => a - b);
    const drop = Math.floor(nums.length * 0.1);
    const core = nums.slice(drop, nums.length - drop);
    const mid = Math.floor(core.length / 2);
    const median = core.length % 2 ? core[mid] : (core[mid - 1] + core[mid]) / 2;
    return { median: Math.round(median), samples: nums.length, url };
  } catch (err) {
    return null;
  }
}

module.exports = { ebaySoldMedian };
