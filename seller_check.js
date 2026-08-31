// Legge la reputazione del venditore da una pagina annuncio Vinted gia' aperta.
// Zero LLM: solo lettura del DOM/testo. Serve all'analisi approfondita per capire
// se il venditore e' affidabile (recensioni, valutazione, iscrizione, ultimo accesso).
async function extractSellerInfo(page) {
  try {
    return await page.evaluate(() => {
      const body = document.body.innerText || '';
      const clean = body.replace(/ /g, ' ');

      const pick = (re) => {
        const m = clean.match(re);
        return m ? m[1].trim() : null;
      };

      // Numero di recensioni: "123 recensioni" / "1 recensione"
      const reviewsRaw = pick(/(\d+)\s+recension[ei]/i);
      const reviews = reviewsRaw != null ? parseInt(reviewsRaw, 10) : null;

      // Valutazione media: spesso resa come stelle; a volte "4,8" vicino a "recensioni"
      const ratingRaw = pick(/valutazione[^\d]{0,20}(\d[.,]\d)/i) || pick(/(\d[.,]\d)\s*\/\s*5/);
      const rating = ratingRaw ? parseFloat(ratingRaw.replace(',', '.')) : null;

      // "A proposito" / iscrizione: "Iscritto/a: 3 anni fa" o una data
      const joined = pick(/Iscritt[oa][^\n:]*:?\s*([^\n]{2,40})/i);

      // Ultimo accesso: "Ultimo accesso: 2 ore fa"
      const lastSeen = pick(/Ultim[oa] access[oi][^\n:]*:?\s*([^\n]{2,40})/i);

      // Localita' venditore
      const location = pick(/(?:Localit[aà]|Si trova a|Da)\s*:?\s*([A-Za-zÀ-ÿ' ]{2,40})/);

      // Nome/handle del venditore, se presente un link al profilo
      const profileLink = document.querySelector('a[href*="/member/"]');
      const sellerName = profileLink ? profileLink.textContent.trim().slice(0, 40) : null;
      const profileUrl = profileLink ? profileLink.href : null;

      // Feedback "positivo/negativo" grezzo se elencato
      const negative = /recension[ei] negativ|feedback negativ|truffa|non ha spedito|mai arrivato/i.test(clean);

      return { reviews, rating, joined, lastSeen, location, sellerName, profileUrl, negativeFlags: negative };
    });
  } catch {
    return { reviews: null, rating: null, joined: null, lastSeen: null, location: null, sellerName: null, profileUrl: null, negativeFlags: false };
  }
}

// Estrae fino a maxImgs URL di foto reali dell'annuncio (non avatar, non icone).
async function extractListingImages(page, maxImgs = 3) {
  try {
    const urls = await page.evaluate(() => {
      const out = [];
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.currentSrc || img.src || '';
        // foto annuncio Vinted: dominio immagini, dimensioni grandi
        if (/vinted|cloudfront|photos/i.test(src) && (img.naturalWidth > 200 || img.width > 200)) {
          if (!out.includes(src)) out.push(src);
        }
      }
      return out;
    });
    return urls.slice(0, maxImgs);
  } catch {
    return [];
  }
}

// Verdetto rapido, solo regole (nessun LLM), su quanto fidarsi del venditore.
function sellerTrustSummary(info) {
  if (info.reviews == null) return 'sconosciuta (profilo non leggibile)';
  if (info.reviews === 0) return 'NUOVO/0 recensioni — cautela alta, paga solo con Protezione Acquisti';
  if (info.reviews < 3) return `poche recensioni (${info.reviews}) — cautela`;
  if (info.rating != null && info.rating < 4.0) return `${info.reviews} recensioni ma valutazione bassa (${info.rating}) — cautela`;
  return `${info.reviews} recensioni${info.rating != null ? `, valutazione ${info.rating}` : ''} — nella norma`;
}

module.exports = { extractSellerInfo, extractListingImages, sellerTrustSummary };
