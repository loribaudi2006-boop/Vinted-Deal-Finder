// Watchdog: gira ogni ~15 min in un job GitHub Actions minuscolo e indipendente.
// Controlla se il workflow principale del bot (bot.yml) e' attivo. Se e' fermo da
// troppo tempo (GitHub a volte salta o ritarda di ore gli avvii programmati),
// manda un messaggio Telegram che spiega il problema e prova a riavviarlo da solo.
//
// Env richieste:
//   GH_TOKEN            -> secrets.GITHUB_TOKEN (serve permniss. actions: write)
//   GITHUB_REPOSITORY   -> fornita in automatico da GitHub Actions (owner/repo)
//   TELEGRAM_BOT_TOKEN  -> secret
//   TELEGRAM_CHAT_ID    -> secret
//   DEFAULT_BRANCH      -> ramo su cui lanciare bot.yml (default: main)
//   BOT_WORKFLOW        -> file del workflow del bot (default: bot.yml)
//   GAP_MINUTES         -> minuti di inattivita' oltre i quali si considera "fermo" (default: 20)

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const WORKFLOW = process.env.BOT_WORKFLOW || "bot.yml";
const BRANCH = process.env.DEFAULT_BRANCH || "main";
const GAP_MIN = Number(process.env.GAP_MINUTES || 20);
const name = repo ? repo.split("/")[1] : "bot";

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
  const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) console.error("Invio Telegram fallito:", res.status, await res.text());
}

(async () => {
  const res = await gh(`actions/workflows/${WORKFLOW}/runs?per_page=5`);
  if (!res.ok) {
    console.error("Chiamata API runs fallita:", res.status, await res.text());
    process.exit(0); // non facciamo rumore per un errore temporaneo dell'API
  }
  const runs = (await res.json()).workflow_runs || [];
  if (!runs.length) {
    console.log("Nessun run trovato per", WORKFLOW);
    process.exit(0);
  }

  const latest = runs[0];
  console.log(`Ultimo run: ${latest.id} status=${latest.status} conclusion=${latest.conclusion} updated=${latest.updated_at}`);

  if (latest.status === "in_progress" || latest.status === "queued") {
    console.log("Il bot risulta attivo. Tutto ok.");
    process.exit(0);
  }

  const ageMin = (Date.now() - new Date(latest.updated_at).getTime()) / 60000;
  const prev = runs[1];
  const twoFails =
    latest.conclusion && latest.conclusion !== "success" &&
    prev && prev.conclusion && prev.conclusion !== "success";

  if (twoFails) {
    await tg(
      `❌ <b>${name}</b>: gli ultimi due job del bot sono falliti (ultimo esito: <code>${latest.conclusion}</code>).\n` +
      `Non lo riavvio in automatico per non entrare in un loop di errori — conviene guardare i log:\n${latest.html_url}`
    );
    process.exit(0);
  }

  if (ageMin < GAP_MIN) {
    console.log(`Job finito da ${ageMin.toFixed(0)} min: rientra nella norma, non intervengo.`);
    process.exit(0);
  }

  const motivo =
    latest.conclusion === "success"
      ? "GitHub non ha avviato il job programmato successivo"
      : `l'ultimo job si e' chiuso con esito "${latest.conclusion}"`;
  await tg(
    `⚠️ <b>${name}</b>: il bot e' fermo da circa ${Math.round(ageMin)} minuti (${motivo}).\n` +
    `Provo a riavviarlo adesso.`
  );

  const disp = await gh(`actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: BRANCH }),
  });
  if (disp.ok || disp.status === 204) {
    console.log("Riavvio richiesto con successo.");
    await tg(`✅ <b>${name}</b>: riavvio avviato. Se entro qualche minuto non torna a funzionare, controlla la tab Actions su GitHub.`);
  } else {
    console.error("Dispatch fallito:", disp.status, await disp.text());
    await tg(`❗ <b>${name}</b>: non sono riuscito a riavviarlo in automatico (errore ${disp.status}). Vai su GitHub → Actions → "${WORKFLOW}" → "Run workflow".`);
  }
})().catch((e) => {
  console.error("Watchdog errore:", e);
  process.exit(0);
});
