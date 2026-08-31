# Bottone "Approfondisci" + database prezzi (agosto 2026)

## Cosa fa
Ogni avviso Telegram ora ha 2 bottoni: **🔍 Approfondisci** e **🗄 Archivia**.

**Approfondisci** (parte solo se lo premi):
1. Riapre l'annuncio ADESSO → se venduto/rimosso te lo dice e archivia.
2. Legge la reputazione del venditore (recensioni, valutazione) dalla pagina.
3. Prezzi del **venduto su eBay.it** + mediana dal **database prezzi locale**.
4. **1 sola chiamata Gemini** (testo + fino a 3 foto): rischio truffa, valutazione
   foto, valore di mercato, verdetto COMPRA / VALUTA DI PERSONA / LASCIA, prezzo di
   rivendita col metodo dei 4 passi, cose da verificare prima di comprare.
5. Manda il report. Bottoni report: **💬 Bozza messaggio venditore** (nessun Gemini),
   **🗄 Archivia**.

Nessun bottone "compra" o "fai offerta": la decisione e il contatto restano a te.

## Tetto quota
`config.json` → `deepAnalysis.maxPerDay` (default 15). Oltre il tetto il bottone
risponde "limite raggiunto" **senza chiamare Gemini**. Il resto del bot non e' mai
a rischio per questa funzione.

## File
- `telegram_poll.js` — ascolta i bottoni (API Telegram, gira in run_loop.sh con triage/analyze). Zero Gemini.
- `deep_analyze.js` — l'analisi approfondita (lanciata in background dai bottoni).
- `seller_check.js` — reputazione venditore + foto annuncio (scraping).
- `ebay_sold.js` — mediana prezzi venduto eBay.it (scraping).
- `price_history.js` — database prezzi auto-costruito. `index.js` gli passa gli annunci
  gia' scaricati (nessuna richiesta extra a Vinted); dopo ~3 settimane ha la mediana reale.

## Cosa NON e' cambiato
Ricerca, filtri, keyword, categorie, soglie, triage e analisi automatica: identici.
`index.js` ha solo 3 righe isolate (in try/catch) per il log prezzi.

## Stato dati nuovi (in data/, versionati come gli altri)
`price_history.json`, `deep_state.json`, `telegram_state.json` — si creano da soli.
