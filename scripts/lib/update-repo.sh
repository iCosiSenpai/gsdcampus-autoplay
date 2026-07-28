# update-repo.sh — aggiornamento del codice alla versione origin/main (sourcato).
#
# ATTENZIONE ALLINEAMENTO: questa è l'estrazione della update_repo() INLINE di
# install.sh (che NON può sourcare questo file: install.sh arriva fresco da
# raw.githubusercontent e gira anche PRIMA che il repo esista/sia aggiornato —
# chicken-egg). Se modifichi la logica qui, aggiorna anche install.sh e viceversa.
# Usata da: scripts/auto-update.sh (job periodico, sempre post-clone).
#
# Richiede: $DIR (root progetto) definito dal chiamante; git disponibile.
# Non usa `set -e` proprio: ogni fallimento degrada con warning (unattended-safe).
#
# Ritorna 1 se l'aggiornamento NON è stato eseguito (fetch fallito): prima
# proseguiva mergiando su un origin/main vecchio e dichiarava "progetto
# aggiornato" anche quando non era stato scaricato nulla.

update_repo() {
  local branch="${1:-main}"
  local before after
  before=$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo "")
  if ! git -C "$DIR" fetch --quiet origin "$branch"; then
    echo "[update-repo] fetch non riuscito: nessun aggiornamento eseguito, resto su ${before:-versione locale}."
    return 1
  fi

  # Transizione known_answers.json -> gitignorato (v. commento in install.sh):
  # se è ancora tracciato e modificato, backup delle risposte, reset al HEAD
  # (così l'ff-merge procede), poi restore sul file ormai gitignorato.
  local ka_restore=""
  if git -C "$DIR" ls-files --error-unmatch data/known_answers.json >/dev/null 2>&1 \
     && ! git -C "$DIR" diff --quiet -- data/known_answers.json 2>/dev/null; then
    cp "$DIR/data/known_answers.json" "$DIR/data/known_answers.json.__keep" 2>/dev/null && ka_restore="$DIR/data/known_answers.json.__keep"
    git -C "$DIR" checkout -- data/known_answers.json 2>/dev/null || true
  fi

  if ! git -C "$DIR" merge --ff-only "origin/$branch" >/dev/null 2>&1; then
    # File tracciati sporchi: riallineo forzato a origin (repo = source of
    # truth; le modifiche legittime sono tutte gitignorate).
    echo "[update-repo] ff non possibile, riallineo a origin/$branch (reset --hard)."
    git -C "$DIR" reset --hard "origin/$branch" >/dev/null 2>&1 || echo "[update-repo] reset fallito, resto sulla versione locale."
  fi

  if [ -n "$ka_restore" ] && [ -f "$ka_restore" ]; then
    mv -f "$ka_restore" "$DIR/data/known_answers.json" 2>/dev/null || rm -f "$ka_restore" 2>/dev/null
  fi

  # Esito basato sullo sha reale, non sul comando che è andato a buon fine.
  after=$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo "")
  if [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]; then
    echo "[update-repo] aggiornato: $before -> $after"
  else
    echo "[update-repo] già all'ultima versione (${after:-?})."
  fi
  return 0
}
