#!/bin/zsh

# Credenziale Ollama Cloud isolata nel Portachiavi macOS. Non accetta mai il
# segreto come argomento: `security ... -w` senza valore lo legge in modo
# interattivo, evitando cronologia shell, ps, config.json e log.
OLLAMA_KEYCHAIN_SERVICE="com.gsdcampus.autoplay.ollama-api-key"
OLLAMA_KEYCHAIN_ACCOUNT="gsdcampus-autoplay"

ollama_api_key_present() {
  security find-generic-password \
    -a "$OLLAMA_KEYCHAIN_ACCOUNT" \
    -s "$OLLAMA_KEYCHAIN_SERVICE" \
    -w >/dev/null 2>&1
}

ollama_api_key_read() {
  security find-generic-password \
    -a "$OLLAMA_KEYCHAIN_ACCOUNT" \
    -s "$OLLAMA_KEYCHAIN_SERVICE" \
    -w 2>/dev/null
}

ollama_api_key_store_prompt() {
  security add-generic-password \
    -a "$OLLAMA_KEYCHAIN_ACCOUNT" \
    -s "$OLLAMA_KEYCHAIN_SERVICE" \
    -U -w
}

ollama_api_key_delete() {
  security delete-generic-password \
    -a "$OLLAMA_KEYCHAIN_ACCOUNT" \
    -s "$OLLAMA_KEYCHAIN_SERVICE" >/dev/null 2>&1
}
