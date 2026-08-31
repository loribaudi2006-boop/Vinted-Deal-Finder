// Cloudflare Worker — "sveglino" esterno per il Vinted Deal Finder.
// Gira su un cron di Cloudflare (ogni 3 min, vedi wrangler.toml), quindi NON dipende
// dallo scheduler di GitHub Actions (che salta spesso, soprattutto di notte).
//
// Ad ogni giro controlla il workflow bot.yml:
//  - se non c'e' nessun run       -> lo avvia
//  - se un run risulta "in_progress" ma non salva stato da > STALL_MIN minuti (piantato)
//                                  -> lo chiude e ne avvia uno nuovo
//  - se l'ultimo run e' finito da > GAP_MIN minuti e non e' ripartito niente
//                                  -> ne avvia uno nuovo
//  - se gli ultimi due run sono falliti davvero
//                                  -> avvisa su Telegram e NON riavvia (per non ciclare)
//
// Secret da impostare (wrangler secret put ...):
//   GITHUB_TOKEN        token GitHub fine-grained: repo Vinted-Deal-Finder, permesso Actions = Read and write
//   TELEGRAM_BOT_TOKEN  (opzionale) per gli avvisi
//   TELEGRAM_CHAT_ID    (opzionale)

const OWNER = "loribaudi2006-boop";
const REPO = "Vinted-Deal-Finder";
const WORKFLOW = "bot.yml";
const BRANCH = "main";
const STALL_MIN = 25; // "in_progress" ma nessun commit su data/ da > tot min = piantato
const GAP_MIN = 8;    // ultimo run finito da > tot min e nessuno ripartito = riavvia

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "vinted-bot-cf-watchdog",
      ...(init.headers || {}),
    },
  });
}

async function tg(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

// Minuti dall'ultimo commit che ha toccato data/ (il bot fa un heartbeat ~ogni 10 min).
async function stateStaleMinutes(env) {
  const r = await gh(env, `commits?sha=${BRANCH}&path=data&per_page=1`);
  if (!r.ok) return null;
  const arr = await r.json();
  const d =
    arr?.[0]?.commit?.committer?.date || arr?.[0]?.commit?.author?.date || null;
  return d ? (Date.now() - new Date(d).getTime()) / 60000 : null;
}

async function dispatch(env) {
  const r = await gh(env, `actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: BRANCH }),
  });
  return r.ok || r.status === 204;
}

async function check(env) {
  const r = await gh(env, `actions/workflows/${WORKFLOW}/runs?per_page=5`);
  if (!r.ok) return `errore API runs: ${r.status}`;
  const runs = (await r.json()).workflow_runs || [];

  if (!runs.length) {
    const ok = await dispatch(env);
    return `nessun run trovato -> dispatch(${ok})`;
  }

  const latest = runs[0];

  if (latest.status === "queued") return "un run e' in coda, ok";

  if (latest.status === "in_progress") {
    const runAge =
      (Date.now() - new Date(latest.run_started_at || latest.created_at).getTime()) / 60000;
    const stall = await stateStaleMinutes(env);
    if (runAge < STALL_MIN || stall == null || stall < STALL_MIN) {
      return `attivo (run ${Math.round(runAge)}m, ultimo sync ${stall == null ? "?" : Math.round(stall) + "m"}), ok`;
    }
    await gh(env, `actions/runs/${latest.id}/cancel`, { method: "POST" }).catch(() => {});
    const ok = await dispatch(env);
    await tg(
      env,
      `⚠️ <b>Vinted bot</b>: il job risultava attivo ma non salva stato da ~${Math.round(stall)} min (piantato). Chiuso e ${ok ? "riavviato" : "riavvio richiesto — ripartira' entro qualche minuto"}.`
    );
    return `zombie (stall ${Math.round(stall)}m) -> cancel + dispatch(${ok})`;
  }

  // ultimo run completato
  const ageMin = (Date.now() - new Date(latest.updated_at).getTime()) / 60000;
  const prev = runs[1];
  const realFail = (c) => c === "failure" || c === "startup_failure";

  if (realFail(latest.conclusion) && prev && realFail(prev.conclusion)) {
    await tg(
      env,
      `❌ <b>Vinted bot</b>: gli ultimi due avvii sono falliti davvero (${latest.conclusion}). NON riavvio in automatico per non ciclare. Controlla i log:\nhttps://github.com/${OWNER}/${REPO}/actions`
    );
    return "due fallimenti di fila -> stop";
  }

  if (ageMin < GAP_MIN) return `finito da ${Math.round(ageMin)}m (passaggio di consegne), ok`;

  const ok = await dispatch(env);
  await tg(
    env,
    `⚠️ <b>Vinted bot</b>: fermo da ~${Math.round(ageMin)} min (GitHub non ha riavviato). Riavvio ${ok ? "fatto" : "richiesto"}.`
  );
  return `fermo ${Math.round(ageMin)}m -> dispatch(${ok})`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      check(env)
        .then((r) => console.log("[watchdog]", r))
        .catch((e) => console.error("[watchdog] errore:", e))
    );
  },
  // Aprendo l'URL del worker nel browser esegue un controllo al volo (utile per testare).
  async fetch(req, env) {
    const out = await check(env).catch((e) => "errore: " + (e && e.message));
    return new Response(out + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
