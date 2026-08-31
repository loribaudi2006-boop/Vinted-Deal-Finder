#!/bin/bash
# Orchestratore per GitHub Actions: dato che il cron nativo di GitHub non scende
# sotto i 5 minuti, questo script resta acceso da solo e cicla internamente.
# Per ridurre il ritardo end-to-end (annuncio pubblicato -> notifica) e non
# ritrovarsi ad aprire annunci gia' venduti:
#   - index.js gira da solo ogni 60s (solo scraping, gratis)
#   - triage.js e analyze_gemini.js girano ATTACCATI nello stesso giro ogni 60s:
#     appena il triage segna un candidato "promising", l'analisi lo prende subito
#     dopo, invece di aspettare fino a 5 minuti il timer separato di prima.
# Il job GitHub Actions ha un limite massimo di 6 ore: restiamo a 5h50m per
# avere margine di sicurezza prima che il runner venga terminato forzatamente.
set -uo pipefail
cd "$(dirname "$0")"

DURATION_SECONDS=$((5 * 3600 + 50 * 60))
END_TIME=$(($(date +%s) + DURATION_SECONDS))

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1"
}

run_loop() {
  local script=$1
  local interval=$2
  while [ "$(date +%s)" -lt "$END_TIME" ]; do
    node "$script" || log "Errore in $script (continuo comunque, riprovo al prossimo giro)"
    sleep "$interval"
  done
}

# Triage + analisi nello stesso giro, uno dopo l'altro: cosi' un candidato
# promettente viene notificato pochi secondi dopo il triage, non minuti dopo.
run_triage_analyze_loop() {
  local interval=$1
  while [ "$(date +%s)" -lt "$END_TIME" ]; do
    node triage.js || log "Errore in triage.js (continuo comunque)"
    node analyze_gemini.js || log "Errore in analyze_gemini.js (continuo comunque)"
    # Cancella dalla chat gli avvisi Telegram scaduti (solo API Telegram, niente Gemini).
    node msg_cleanup.js || log "Errore in msg_cleanup.js (continuo comunque)"
    sleep "$interval"
  done
}

commit_data() {
  while [ "$(date +%s)" -lt "$END_TIME" ]; do
    sleep 600
    if [ -n "$(git status --porcelain data/)" ]; then
      git add data/
      git -c user.name="vinted-bot" -c user.email="bot@users.noreply.github.com" commit -m "sync stato bot" -q
      # Allineati con eventuali push arrivati nel frattempo (es. una modifica al
      # codice pushata mentre il job gira) prima di spingere: senza questo, dopo
      # un push esterno il git push fallisce in silenzio per tutta la vita del job.
      # NB: serve "origin main" esplicito, sul runner non c'e' upstream tracking.
      if git pull --rebase -q origin main && git push -q; then
        log "Stato salvato su Git."
      else
        git rebase --abort 2>/dev/null || true
        log "Sync fallito (pull/push), riprovo al prossimo giro."
      fi
    fi
  done
}

log "Avvio loop: durata massima ${DURATION_SECONDS}s (~5h50m)."

run_loop index.js 60 &
PID_INDEX=$!
run_triage_analyze_loop 60 &
PID_PIPELINE=$!
commit_data &
PID_COMMIT=$!

wait "$PID_INDEX" "$PID_PIPELINE" "$PID_COMMIT"

log "Loop terminato, salvo lo stato finale prima che il job chiuda."
if [ -n "$(git status --porcelain data/)" ]; then
  git add data/
  git -c user.name="vinted-bot" -c user.email="bot@users.noreply.github.com" commit -m "sync stato bot (fine job)" -q
  if git pull --rebase -q origin main && git push -q; then :; else
    git rebase --abort 2>/dev/null || true
    log "Push finale fallito."
  fi
fi
log "Fine."
