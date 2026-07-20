# Sicurezza: members.db, token, PINNED_TAG

## members.db — audit

| Voce | Dettaglio |
|------|-----------|
| Path | `data/members.db` (SQLite) |
| Contenuto | `codice_fiscale`, `nome`, `cognome`, **`autologin_url`** (token di accesso), `imported_at` |
| Git | **gitignorato** (non va in push). Se finisce in un zip “per colleghi”, lo script `prepare-package` lo esclude. |
| Permessi | `0600` (solo utente Mac) al `initDb` |
| Consenso | CF e link di autologin sono credenziali: non in git, non in chat pubbliche |

**Come entra l’account sul Mac (ordine di priorità)**

1. **Collega (caso normale):** incolla **solo il proprio link autologin** in setup / “Chi sei?”. **Nessun CSV richiesto.**
2. **Referente (opzionale):** ha l’export FNC → `import-members` una volta su quel Mac (o AirDrop del solo CSV a chi fa la coda multi-CF).  
3. **Mai:** mettere `members.db` o CSV con token su GitHub / zip pubblici.

**Cosa non fare**

- Non committare `data/members.db` o dump CSV con URL autologin.
- Non copiare `data/accounts/<CF>/storage_state.json` tra account (cookie di sessione).
- Non loggare URL autologin interi (il logger redige token/CF).
- Non dire ai colleghi “serve il CSV” se possono incollare il link.

**Rotazione token (referente o chi ha l’export)**

1. Nuovo link dall’utente **oppure** CSV aggiornato se gestisci l’elenco.
2. Link: aggiorna `config.json` / set-active. CSV: `node scripts/import-members.js "<csv>"` poi set-active.
3. `./start.sh`

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
