# package-hash.sh — hash di package.json + package-lock per npm install condizionale.
# Sourced da setup.sh e check-requirements.sh (DIR deve essere settata al root progetto).

# Calcola un hash stabile di package.json + package-lock.json.
calc_package_hash() {
  if command -v sha256sum &>/dev/null; then
    (sha256sum "$DIR/package.json" "$DIR/package-lock.json" 2>/dev/null || true) | sha256sum | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    (shasum -a 256 "$DIR/package.json" "$DIR/package-lock.json" 2>/dev/null || true) | shasum -a 256 | awk '{print $1}'
  else
    # Fallback per macOS senza shasum (improbabile): nome, dimensione e mtime.
    stat -f "%N%z%m" "$DIR/package.json" "$DIR/package-lock.json" 2>/dev/null | md5
  fi
}

# Salva l'hash attuale in .package_hash
save_package_hash() {
  calc_package_hash > "$DIR/.package_hash"
}

# True se manca .package_hash o l'hash non coincide.
package_hash_changed() {
  [ ! -f "$DIR/.package_hash" ] && return 0
  local current saved
  current=$(calc_package_hash)
  saved=$(cat "$DIR/.package_hash" 2>/dev/null || echo "")
  [ "$current" != "$saved" ]
}

# True se .package_hash esiste e coincide (deps già allineate).
package_hash_ok() {
  local hash_file="$DIR/.package_hash"
  [ -f "$hash_file" ] || return 1
  local current saved
  current=$(calc_package_hash)
  saved=$(cat "$hash_file" 2>/dev/null || echo "")
  [ -n "$current" ] && [ "$current" = "$saved" ]
}
