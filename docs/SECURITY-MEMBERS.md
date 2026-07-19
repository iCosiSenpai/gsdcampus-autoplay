# Sicurezza: members.db, token, PINNED_TAG

## members.db — audit

| Voce | Dettaglio |
|------|-----------|
| Path | `data/members.db` (SQLite) |
| Contenuto | `codice_fiscale`, `nome`, `cognome`, **`autologin_url`** (token di accesso), `imported_at` |
| Git | **gitignorato** (non va in push). Se finisce in un zip “per colleghi”, lo script `prepare-package` lo esclude. |
| Permessi | `0600` (solo utente Mac) al `initDb` |
| Consenso | l’elenco utenti/CF e i link di autologin sono dati personali/credenziali: importare solo CSV autorizzati dall’organizzazione; non condividere il DB su chat o drive pubblici |

**Cosa non fare**

- Non committare `data/members.db` o dump CSV con URL autologin.
- Non copiare `data/accounts/<CF>/storage_state.json` tra account (cookie di sessione).
- Non loggare URL autologin interi (il logger redige token/CF).

**Rotazione token**

1. Esporta CSV aggiornato dalla piattaforma.
2. `node scripts/import-members.js "<csv>"`
3. `node scripts/lib/members-cli.js set-active <CF>`
4. `./start.sh`

## PINNED_TAG (install immutabile)

In `install.sh`:

```bash
PINNED_TAG=""   # es. "v1.1.0"
```

- Se valorizzato, il primo clone usa `git clone --branch "$PINNED_TAG"` (tag immutabile) invece di `main` mobile.
- Utile per store che vogliono congelare la versione e aggiornare solo con tag esplicito.
- Se il tag non esiste, fallback su `BRANCH` (default `main`) con warning.
- Il curl one-liner su `main` resta mobile: ogni push cambia il prossimo install **solo se** non si pinna.

**Rilascio maintainer**

```bash
# dopo commit feature su main (package.json version 1.1.0+)
git tag v1.1.0
git push origin v1.1.0
# opzionale: impostare PINNED_TAG=v1.1.0 in install.sh (fork/store) per freeze
```

Tag `v1.1.0` = baseline post tier A–E (browser resiliente, course-runner, multi-CF, metrics, notify).

## Share metriche (opt-in)

- `config.shareMetrics: true` abilita `node scripts/lib/metrics-cli.js share`
- Payload: solo conteggi `phase`, ore, `storeTag` opzionale **anonimo** — **mai CF**
- Worker: `POST /metrics` (ack only)

## Coda multi-membro

```json
"memberQueue": ["CF1", "CF2"],
"memberQueueIndex": 0
```

A fine corsi di un CF, l’autoplay avanza al successivo (riscrive `config.json` da `members.db`). Richiede restart scheduler per applicare.
