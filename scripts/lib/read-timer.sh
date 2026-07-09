#!/bin/zsh
# read-timer.sh — helper `read_with_timer` per messaggi che l'utente deve leggere.
#
# Uso: read_with_timer <secondi> "<messaggio>"
#
# Mostra il messaggio (se non vuoto) e un countdown di N secondi. Premere Invio
# (o un qualunque tasto) salta subito il countdown. Non blocca mai l'esecuzione:
# restituisce sempre 0 (sicuro sotto `set -e`). Su non-TTY (pipe/CI) salta il
# countdown ma stampa comunque il messaggio.
#
# Source da setup.sh / launch-ai-supervisor.sh:  source "$DIR/scripts/lib/read-timer.sh"

read_with_timer() {
  local secs="$1"; shift
  local msg="$1"
  [ -n "$msg" ] && echo -e "$msg"

  # Su non-TTY non possiamo leggere tasti: salta il countdown.
  if ! [ -t 0 ]; then
    return 0
  fi

  local i
  for ((i = secs; i > 0; i--)); do
    printf "\r\033[K  Attendere %2d s — Invio per saltare... " "$i"
    # read -t 1 -k 1: attende 1 tasto per al massimo 1 secondo. Se arriva un tasto
    # entro il secondo, esce subito (skip). `|| true` rende la lista sempre vera
    # così set -e non abortisce sul timeout (read ritorna non-zero a timeout).
    if read -s -t 1 -k 1 2>/dev/null; then
      printf "\r\033[K"
      return 0
    fi
  done
  printf "\r\033[K"
  return 0
}