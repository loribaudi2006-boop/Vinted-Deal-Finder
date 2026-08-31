// Watchdog: job GitHub Actions minuscolo e indipendente (~ogni 15 min + a fine di
// ogni ciclo di bot.yml). Verifica che bot.yml sia attivo; se e' fermo prova a
// riavviarlo da solo e, se non ci riesce (o se il bot continua a crashare), manda
// su Telegram le istruzioni ESATTE passo-passo per rimetterlo su a mano.
//
// Env:
//   GH_TOKEN            -> secrets.GITHUB_TOKEN (serve permesso actions: write)
//   GITHUB_REPOSITORY   -> fornita in automatico da GitHub Actions (owner/repo)
//   TELEGRAM_BOT_TOKEN  -> secret
//   TELEGRAM_CHAT_ID    -> secret
//   DEFAULT_BRANCH      -> ramo su cui lanciare bot.yml (default: main)
//   BOT_WORKFLOW        -> file del workflow del bot (default: bot.yml)
//   GAP_MINUTES         -> minuti di inattivita' oltre i quali si considera "fermo" (default: 20)
//   STALL_MINUTES       -> se un job risulta "in_progress" ma non salva stato da piu' di
//                          tanti minuti, e' piantato (zombie): lo si chiude e riavvia (default: 35)
//   REQUIRED_SECRETS    -> elenco separato da virgola dei secret che il bot richiede

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const WORKFLOW = process.env.BOT_WORKFLOW || "bot.yml";
const BRANCH = process.env.DEFAULT_BRANCH || "main";
const GAP_MIN = Number(process.env.GAP_MINUTES || 20);
const STALL_MIN = Number(process.env.STALL_MINUTES || 35);
const SECRETS = (process.env.REQUIRED_SECRETS || "TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID")
  .split(",").map((s) => s.trim()).filter(Boolean);
const name = repo ? repo.split("/")[1] : "bot";

// Esiti che indicano un vero crash del bot (vale la pena fermarsi e guardare i log).
// "cancelled" e "timed_out" NON sono qui: per questo bot sono normali (GitHub chiude
// il job lungo al limite di tempo a ogni ciclo) e NON devono bloccare il riavvio.
const REAL_FAIL = new Set(["failure", "startup_failure"]);
const isRealFail = (c) => REAL_FAIL.has(c);

async function gh(pathname, opts = {}) {
  return fetch(`https://api.github.com/repos/${repo}/${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
}

async function tg(text) {
  if (!tgToken || !chatId) {
    console.log("Telegram non configurato (manca token o chat id), salto la notifica.");
    return;
  }
  // Telegram limita a 4096 caratteri: spezzo se serve.
  const chunks = text.match(/[\s\S]{1,3900}/g) || [text];
  for (const c of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) console.error("Invio Telegram fallito:", res.status, await res.text());
  }
}

const ACTIONS_URL = `https://github.com/${repo}/actions`;
const WF_URL = `https://github.com/${repo}/actions/workflows/${WORKFLOW}`;
const SECRETS_URL = `https://github.com/${repo}/settings/secrets/actions`;

// Istruzioni per rimettere in moto il bot a mano.
function comeRiavviarlo() {
  return (
    `🛠 <b>COME RIAVVIARLO A MANO</b> (1 minuto, funziona anche da telefono):\n\n` +
    `<b>Metodo A — dal browser, senza installare niente:</b>\n` +
    `1. Apri: ${WF_URL}\n` +
    `2. In alto a destra premi il bottone <b>"Run workflow"</b>.\n` +
    `3. Lascia selezionato <b>Branch: ${BRANCH}</b>.\n` +
    `4. Premi il bottone verde <b>"Run workflow"</b>.\n` +
    `5. Aspetta ~30 secondi e ricarica la pagina: deve comparire una riga con il\n` +
    `   pallino giallo che gira ("in progress"). Fatto.\n\n` +
    `<b>Metodo B — da PC con GitHub CLI installato:</b>\n` +
    `<code>gh workflow run ${WORKFLOW} --repo ${repo} --ref ${BRANCH}</code>\n\n` +
    `<b>Verifica:</b> apri ${ACTIONS_URL} — deve esserci un run giallo "in progress";\n` +
    `entro 2-3 minuti il bot ricomincia a mandare messaggi.`
  );
}

// Istruzioni per quando il bot parte e crasha subito (due failure di fila).
function comeLeggereILog(htmlUrl) {
  return (
    `🔎 <b>IL BOT PARTE E SI CHIUDE SUBITO CON ERRORE</b> — cosa controllare:\n\n` +
    `1. Apri il log dell'ultimo run:\n${htmlUrl}\n` +
    `2. Clicca sul job con la <b>X rossa</b>, poi apri lo step con la X rossa e guarda\n` +
    `   le ultime righe. Confronta con i casi qui sotto:\n\n` +
    `• <b>"429" / "quota" / "RESOURCE_EXHAUSTED"</b>\n` +
    `   = quota giornaliera Gemini finita. Non devi fare niente: riparte da solo\n` +
    `   dopo le ~09:00 ora italiana, quando la quota si azzera.\n\n` +
    `• <b>"secret not found" / "... is undefined" / errore 401 da Telegram</b>\n` +
    `   = manca o e' sbagliato un secret. Aprili qui:\n   ${SECRETS_URL}\n` +
    `   Devono esserci TUTTI questi, col nome esatto:\n   ${SECRETS.map((s) => "• " + s).join("\n   ")}\n` +
    `   Se ne manca uno: "New repository secret", incolli nome e valore, "Add secret".\n\n` +
    `• <b>"npm ci" fallito / "Cannot find module"</b>\n` +
    `   = dipendenze rotte. Scrivimi: "sistema le dipendenze di ${name}".\n\n` +
    `• <b>Qualsiasi altro errore:</b> copia le ultime ~15 righe del log e mandamele.\n\n` +
    `3. Dopo aver sistemato, riavvia col Metodo A qui sopra.`
  );
}

async function contaRunAttivi() {
  const r = await gh(`actions/workflows/${WORKFLOW}/runs?per_page=5`);
  if (!r.ok) return -1;
  const runs = (await r.json()).workflow_runs || [];
  return runs.filter((x) => x.status === "in_progress" || x.status === "queued").length;
}

// Minuti dall'ultimo commit che ha toccato data/. Mentre lavora, il bot salva lo
// stato (git add data/ + push) ~ogni 10 min: se sono passati molti minuti e un job
// risulta comunque "in_progress", quel job e' piantato (zombie) e va riavviato.
async function minutiDaUltimoSyncStato() {
  try {
    const r = await gh(`commits?sha=${BRANCH}&path=data&per_page=1`);
    if (!r.ok) return null;
    const arr = await r.json();
    const d = arr && arr[0] && arr[0].commit &&
      ((arr[0].commit.committer && arr[0].commit.committer.date) ||
       (arr[0].commit.author && arr[0].commit.author.date));
    return d ? (Date.now() - new Date(d).getTime()) / 60000 : null;
  } catch {
    return null;
  }
}

// Chiede a GitHub di far ripartire bot.yml e verifica dopo 25s che sia davvero partito.
async function riavvia(messaggioIniziale) {
  await tg(messaggioIniziale);
  const disp = await gh(`actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: BRANCH }),
  });
  if (disp.ok || disp.status === 204) {
    console.log("Riavvio richiesto. Verifico tra 25s che sia davvero partito...");
    await new Promise((r) => setTimeout(r, 25000));
    const attivi = await contaRunAttivi();
    if (attivi > 0) {
      await tg(`✅ <b>${name}</b>: riavviato, il bot e' di nuovo in esecuzione. Nessun intervento necessario.`);
    } else {
      await tg(
        `❗ <b>${name}</b>: ho chiesto il riavvio ma dopo 25s non risulta ancora nessun run attivo. ` +
        `Probabile ritardo di GitHub: se entro 5 minuti non torna su, fallo tu:\n\n` +
        comeRiavviarlo()
      );
    }
  } else {
    const errTxt = await disp.text();
    console.error("Dispatch fallito:", disp.status, errTxt);
    let extra = "";
    if (disp.status === 403) extra = "\n(Il token del watchdog non ha il permesso 'actions: write', oppure le Actions sono disattivate nelle impostazioni del repo.)";
    if (disp.status === 404) extra = `\n(Controlla che il file ${WORKFLOW} esista sul branch ${BRANCH} e abbia "workflow_dispatch:" sotto "on:".)`;
    await tg(
      `❗ <b>${name}</b>: NON sono riuscito a riavviarlo in automatico (errore ${disp.status}).${extra}\n\n` +
      comeRiavviarlo()
    );
  }
}

(async () => {
  const res = await gh(`actions/workflows/${WORKFLOW}/runs?per_page=5`);
  if (!res.ok) {
    console.error("Chiamata API runs fallita:", res.status, await res.text());
    process.exit(0); // errore temporaneo dell'API: non facciamo rumore
  }
  const runs = (await res.json()).workflow_runs || [];
  if (!runs.length) {
    console.log("Nessun run trovato per", WORKFLOW);
    process.exit(0);
  }

  const latest = runs[0];
  console.log(`Ultimo run: ${latest.id} status=${latest.status} conclusion=${latest.conclusion} updated=${latest.updated_at}`);

  if (latest.status === "queued") {
    console.log("Un run e' in coda. Tutto ok.");
    process.exit(0);
  }

  if (latest.status === "in_progress") {
    const runAgeMin = (Date.now() - new Date(latest.run_started_at || latest.created_at).getTime()) / 60000;
    const stall = await minutiDaUltimoSyncStato();
    if (runAgeMin < STALL_MIN || stall == null || stall < STALL_MIN) {
      console.log(
        `Bot attivo (run da ${Math.round(runAgeMin)} min, ultimo sync stato ` +
        `${stall == null ? "n/d" : Math.round(stall) + " min fa"}). Tutto ok.`
      );
      process.exit(0);
    }
    // Job "in_progress" ma nessun salvataggio di stato da troppo tempo: e' piantato.
    console.log(`Job ${latest.id} in_progress ma nessun sync stato da ${Math.round(stall)} min: zombie. Lo chiudo e riavvio.`);
    await gh(`actions/runs/${latest.id}/cancel`, { method: "POST" }).catch((e) => console.error("cancel fallito:", e));
    await new Promise((r) => setTimeout(r, 10000));
    await riavvia(
      `⚠️ <b>${name}</b>: il job risultava attivo ma non salvava lo stato da ~${Math.round(stall)} minuti (piantato). L'ho chiuso e sto riavviando il bot.`
    );
    process.exit(0);
  }

  const ageMin = (Date.now() - new Date(latest.updated_at).getTime()) / 60000;
  const prev = runs[1];

  // Due VERI crash di fila -> non riavvio in loop, mando le istruzioni per i log.
  if (isRealFail(latest.conclusion) && prev && isRealFail(prev.conclusion)) {
    await tg(
      `❌ <b>${name}</b>: gli ultimi due avvii del bot sono falliti davvero ` +
      `(ultimo esito: <code>${latest.conclusion}</code>).\n` +
      `Non lo riavvio in automatico per non entrare in un loop di errori.\n\n` +
      comeLeggereILog(latest.html_url)
    );
    process.exit(0);
  }

  if (ageMin < GAP_MIN) {
    console.log(`Job finito da ${ageMin.toFixed(0)} min: rientra nella norma, non intervengo.`);
    process.exit(0);
  }

  let motivo;
  if (latest.conclusion === "success")
    motivo = "il ciclo e' finito regolarmente ma GitHub non ha avviato quello successivo";
  else if (latest.conclusion === "cancelled" || latest.conclusion === "timed_out")
    motivo = "GitHub ha chiuso il job al limite di tempo (normale) ma non e' ripartito quello successivo";
  else
    motivo = `l'ultimo job si e' chiuso con esito "${latest.conclusion}"`;

  await riavvia(`⚠️ <b>${name}</b>: il bot e' fermo da circa ${Math.round(ageMin)} minuti (${motivo}). Provo a riavviarlo adesso.`);
})().catch((e) => {
  console.error("Watchdog errore:", e);
  process.exit(0);
});
