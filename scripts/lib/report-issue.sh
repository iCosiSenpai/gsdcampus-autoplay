# report-issue.sh — helper condiviso (sourced, non eseguito).
#
# Apre UNA issue GitHub per un problema BLOCCANTE (che ferma il comando, il
# terminale o il lavoro), deduplicata per classe+versione: così il maintainer
# riceve una notifica push senza dover leggere i log dal vivo, ma senza spam.
#
# Uso:  report_blocking_issue <root> <klass> <reason>
#   <root>   = cartella del progetto
#   <klass>  = fase/tipo problema (es. crash_loop, preflight_failed, scheduler_start_failed)
#   <reason> = riga breve leggibile
#
# Dedup: un marker logs/.issued_<klass>_<versione-git> impedisce di riaprire la
# stessa issue finché non cambia la versione (nuovo deploy = nuovo tentativo).
# logs/ è gitignorato, quindi i marker non finiscono mai nel repo.
#
# Best-effort: non blocca mai. issue-report.js rispetta già `reportIssues:false`
# in config.json e redige CF/autologin/token/cookie prima di spedire.
report_blocking_issue() {
  local root="$1" klass="$2" reason="$3" ver marker
  [ -n "$root" ] && [ -n "$klass" ] || return 0
  ver="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo nover)"
  marker="$root/logs/.issued_${klass}_${ver}"
  [ -f "$marker" ] && return 0
  mkdir -p "$root/logs" 2>/dev/null || true
  # Marker (dedup) SOLO a invio riuscito: se il send fallisce (receiver/rete giù)
  # non scriviamo il marker → si ritenta al prossimo evento senza perdere la
  # notifica. `send` esce 0 su successo o rifiuto intenzionale (reportIssues:false),
  # e != 0 solo su fallimento reale d'invio.
  if node "$root/scripts/lib/issue-report.js" draft "$klass" "$reason" >/dev/null 2>&1 \
     && node "$root/scripts/lib/issue-report.js" send >/dev/null 2>&1; then
    touch "$marker" 2>/dev/null || true
  fi
}
