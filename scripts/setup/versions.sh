# versions.sh — confronti versione e minimi (sourced da setup.sh; DIR set).

# Versioni minime consigliate delle dipendenze esterne. Se un collega ha già una
# versione >= di questa, lo script NON reinstalla e NON si blocca: va avanti.
# Se la versione è più vecchia, tenta un aggiornamento NON bloccante (se fallisce,
# prosegue con la versione presente piuttosto che abortire). Cosi chi ha gia
# Ollama o Claude Code installati non viene fermato.
MIN_OLLAMA="0.15.0"   # login Cloud e integrazioni moderne
MIN_CLAUDE="2.1.215" # verificata con --bare, --json-schema e --no-session-persistence

# Confronto versione: restituisce 0 se $1 >= $2 (componenti numeriche separate da punto).
version_ge() {
  local a="$1" b="$2"
  local -a A B
  IFS='.' read -A A <<< "$a"
  IFS='.' read -A B <<< "$b"
  local n=${#A} m=${#B} i mx
  mx=$(( n > m ? n : m ))
  for ((i=1; i<=mx; i++)); do
    local ai=${A[i]:-0} bi=${B[i]:-0}
    ai=${ai//[^0-9]/}; bi=${bi//[^0-9]/}
    ai=${ai:-0}; bi=${bi:-0}
    (( ai > bi )) && return 0
    (( ai < bi )) && return 1
  done
  return 0
}

# Estrae la prima versione numerica x.y.z dallo stdout/stderr che le viene passato.
extract_version() {
  grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}
