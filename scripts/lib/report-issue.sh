# report-issue.sh — helper best-effort condiviso (sourced, non eseguito).
#
# Uso:
#   report_blocking_issue <root> <klass> <reason> [command] [exit-code] [start-phase]
#
# Un solo processo Node raccoglie, persiste e invia. La deduplica non è più un
# marker classe+commit: `issue-report-state.json` conserva fingerprint, conteggio,
# URL e ultimo errore, mentre il receiver usa la stessa fingerprint per l'upsert.
# La funzione non blocca mai il chiamante, ma un invio fallito è visibile sia su
# stderr sia in logs/issue-report.log e viene ritentato al prossimo evento.
report_blocking_issue() {
  local root="$1" klass="$2" reason="$3"
  local command_desc="${4:-}" exit_code="${5:-}" start_phase="${6:-}"
  local report_log rc report_output stamp

  [ -n "$root" ] && [ -n "$klass" ] || return 0
  mkdir -p "$root/logs" 2>/dev/null || true
  report_log="$root/logs/issue-report.log"
  stamp="$(date '+%Y-%m-%d %H:%M:%S')"

  if report_output="$(node "$root/scripts/lib/issue-report.js" auto \
    "$klass" "$reason" "" "$command_desc" "$exit_code" "$start_phase" 2>&1)"; then
    rc=0
  else
    rc=$?
  fi

  # Anche l'apertura del log è best-effort. Un filesystem pieno o un permesso
  # rotto nel canale diagnostico non deve diventare il motivo per cui si ferma
  # l'automazione osservata.
  if ! {
    printf '\n[%s] auto-report %s\n' "$stamp" "$klass"
    [ -z "$report_output" ] || printf '%s\n' "$report_output"
    printf '[%s] esito auto-report: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$rc"
  } >> "$report_log" 2>&1; then
    printf 'Impossibile scrivere logs/issue-report.log; esito auto-report %s: %s\n' \
      "$rc" "$report_output" >&2 || true
  fi

  if [ "${rc:-1}" -ne 0 ]; then
    printf 'Segnalazione automatica non consegnata (codice %s): il payload resta nell’outbox e sarà ritentato all’avvio o al prossimo evento.\n' \
      "${rc:-1}" >&2 || true
  fi
  return 0
}
