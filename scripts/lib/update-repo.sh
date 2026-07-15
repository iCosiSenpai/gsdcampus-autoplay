# update-repo.sh — aggiornamento del codice alla versione origin/main (sourcato).
#
# ATTENZIONE ALLINEAMENTO: questa è l'estrazione della update_repo() INLINE di
# install.sh (che NON può sourcare questo file: install.sh arriva fresco da
# raw.githubusercontent e gira anche PRIMA che il repo esista/sia aggiornato —
# chicken-egg). Se modifichi la logica qui, aggiorna anche install.sh e viceversa.
# Usata da: scripts/auto-update.sh (job notturno, sempre post-clone).
#
# Richiede: $DIR (root progetto) definito dal chiamante; git disponibile.
# Non usa `set -e` proprio: ogni fallimento degrada con warning (unattended-safe).

update_repo() {
  local branch="${1:-main}"
  git -C "$DIR" fetch --quiet origin "$branch" || { echo "[update-repo] fetch non riuscito, resto sulla versione locale."; return 1; }

  # Transizione known_answers.json -> gitignorato (v. commento in install.sh):
  # se è ancora tracciato e modificato, backup delle risposte, reset al HEAD
  # (così l'ff-merge procede), poi restore sul file ormai gitignorato.
  local ka_restore=""
  if git -C "$DIR" ls-files --error-unmatch data/known_answers.json >/dev/null 2>&1 \
     && ! git -C "$DIR" diff --quiet -- data/known_answers.json 2>/dev/null; then
    cp "$DIR/data/known_answers.json" "$DIR/data/known_answers.json.__keep" 2>/dev/null && ka_restore="$DIR/data/known_answers.json.__keep"
    git -C "$DIR" checkout -- data/known_answers.json 2>/dev/null || true
  fi

  if git -C "$DIR" merge --ff-only "origin/$branch" >/dev/null 2>&1; then
    echo "[update-repo] progetto aggiornato (ff)."
  else
    # File tracciati sporchi: riallineo forzato a origin (repo = source of
    # truth; le modifiche legittime sono tutte gitignorate).
    echo "[update-repo] ff non possibile, riallineo a origin/$branch (reset --hard)."
    git -C "$DIR" reset --hard "origin/$branch" >/dev/null 2>&1 || echo "[update-repo] reset fallito, resto sulla versione locale."
  fi

  if [ -n "$ka_restore" ] && [ -f "$ka_restore" ]; then
    mv -f "$ka_restore" "$DIR/data/known_answers.json" 2>/dev/null || rm -f "$ka_restore" 2>/dev/null
  fi
  return 0
}
