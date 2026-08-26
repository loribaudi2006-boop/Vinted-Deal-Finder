#!/bin/bash
# Orchestratore per GitHub Actions: dato che il cron nativo di GitHub non scende
# sotto i 5 minuti, questo script resta acceso da solo e cicla internamente sui
# 3 stage con la STESSA cadenza usata oggi da Task Scheduler su Windows
# (index.js ogni 2 min, triage.js ogni 3 min, analyze_gemini.js ogni 5 min).
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

commit_data() {
  while [ "$(date +%s)" -lt "$END_TIME" ]; do
    sleep 600
    if [ -n "$(git status --porcelain data/)" ]; then
      git add data/
      git -c user.name="vinted-bot" -c user.email="bot@users.noreply.github.com" commit -m "sync stato bot" -q
      if git push -q; then
        log "Stato salvato su Git."
      else
        log "Push fallito, riprovo al prossimo giro."
      fi
    fi
  done
}

log "Avvio loop: durata massima ${DURATION_SECONDS}s (~5h50m)."

run_loop index.js 120 &
PID_INDEX=$!
run_loop triage.js 180 &
PID_TRIAGE=$!
run_loop analyze_gemini.js 300 &
PID_ANALYSIS=$!
commit_data &
PID_COMMIT=$!

wait "$PID_INDEX" "$PID_TRIAGE" "$PID_ANALYSIS" "$PID_COMMIT"

log "Loop terminato, salvo lo stato finale prima che il job chiuda."
if [ -n "$(git status --porcelain data/)" ]; then
  git add data/
  git -c user.name="vinted-bot" -c user.email="bot@users.noreply.github.com" commit -m "sync stato bot (fine job)" -q
  git push -q || log "Push finale fallito."
fi
log "Fine."
