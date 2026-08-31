# Sveglino esterno su Cloudflare — installazione

Tempo: ~15 minuti, una volta sola. Tutto gratis. Si fa dal browser, non serve installare niente.

---

## PASSO 1 — Crea il token GitHub (2 min)

1. Vai su **github.com** → in alto a destra la tua foto → **Settings**
2. In fondo a sinistra: **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. Compila:
   - **Token name**: `cloudflare watchdog`
   - **Expiration**: 1 anno (o "No expiration" se preferisci non rifarlo)
   - **Repository access**: seleziona **Only select repositories** → scegli **Vinted-Deal-Finder**
   - **Permissions** → **Repository permissions** → cerca **Actions** → mettilo su **Read and write**
5. **Generate token** → **copia** il valore (inizia con `github_pat_...`). Non lo rivedrai più: tienilo da parte per il Passo 3.

---

## PASSO 2 — Crea il Worker su Cloudflare (5 min)

1. Vai su **dash.cloudflare.com** → registrati (email + password, gratis, nessuna carta)
2. Menu a sinistra: **Workers & Pages** → **Create** → **Create Worker**
3. Nome: `vinted-bot-watchdog` → **Deploy** (per ora deploya l'esempio "Hello World")
4. Ora **Edit code** (o "Continue to project" → "Edit code"):
   - cancella tutto
   - incolla **tutto** il contenuto del file `worker.js` (nella stessa cartella di questo documento)
   - in alto a destra: **Deploy**

---

## PASSO 3 — Metti i segreti (3 min)

Nel Worker: **Settings** → **Variables and Secrets** → **Add**. Per ognuno scegli tipo **Secret** (non "Text"):

| Nome (esatto) | Valore |
|---|---|
| `GITHUB_TOKEN` | il token del Passo 1 |
| `TELEGRAM_BOT_TOKEN` | lo stesso già usato dal bot (opzionale, serve solo per gli avvisi) |
| `TELEGRAM_CHAT_ID` | lo stesso già usato dal bot (opzionale) |

Dopo aver aggiunto i segreti, fai di nuovo **Deploy**.

---

## PASSO 4 — Attiva il controllo automatico ogni 3 minuti (2 min)

Nel Worker: **Settings** → **Triggers** (o "Trigger Events") → **Cron Triggers** → **Add Cron Trigger**
- inserisci: `*/3 * * * *`
- salva

---

## PASSO 5 — Verifica

Apri nel browser l'URL del Worker (lo trovi nella pagina del Worker, tipo
`https://vinted-bot-watchdog.TUONOME.workers.dev`).
Deve stampare una riga tipo:
- `attivo (run 12m, ultimo sync 3m), ok` → tutto bene, il bot gira
- `nessun run trovato -> dispatch(true)` → non girava, l'ha appena avviato
- `fermo 40m -> dispatch(true)` → era fermo, riavviato

Da qui in poi controlla da solo ogni 3 minuti.

---

## Note

- **Non serve toccare il watchdog di GitHub** (`.github/workflows/watchdog.yml`): resta come riserva. I due non si pestano i piedi — se uno riavvia, l'altro vede il bot già attivo e non fa niente. Al massimo, di rado, potresti ricevere due avvisi Telegram ravvicinati.
- **Costo**: ~480 controlli/giorno su un limite gratuito di 100.000. Zero spesa.
- **Se scade il token GitHub**: il Worker smette di funzionare e torni ad affidarti al solo watchdog di GitHub (come prima). Rigeneri il token e lo rimetti nel Passo 3.
- **Per aggiornare il codice del Worker** in futuro: Worker → Edit code → incolla la nuova versione di `worker.js` → Deploy.

---

## In alternativa: da riga di comando (se hai Node)

```
cd cloudflare-watchdog
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler deploy
```
Il cron `*/3 * * * *` è già in `wrangler.toml`, si attiva da solo al deploy.
