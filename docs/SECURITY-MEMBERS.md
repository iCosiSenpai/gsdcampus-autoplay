# Sicurezza: members.db, token, PINNED_TAG

## members.db — modello fleet (fonte di verità per i colleghi)

| Voce | Dettaglio |
|------|-----------|
| Path | `data/members.db` (SQLite) |
| Contenuto | `codice_fiscale`, `nome`, `cognome`, **`autologin_url`**, `imported_at` |
| Git | **Tracciato di proposito** (consenso titolare): al `curl`/clone i colleghi hanno subito l’elenco e **“Chi sei?”** funziona senza CSV e senza incollare link |
| Permessi locali | `0600` consigliati (`initDb`) |
| Journal/WAL | gitignorati (`members.db-journal` ecc.) |

### Flusso utente (obbligatorio da rispettare in docs/AI)

1. Install scarica il repo → **include `members.db`**.
2. Setup **“Chi sei?”**: cerca nome → seleziona → `config.json` riceve CF + autologin dal DB.
3. **Il collega non incolla il link** e **non importa CSV**.
4. CSV / `import-members` = **solo maintainer** quando ruota i token o aggiunge persone, poi `git add data/members.db && commit && push` così tutti lo ricevono al prossimo “Aggiorna e avvia”.

### Cosa non fare

- Non dire ai colleghi “incolla il link” come percorso normale.
- Non dire “serve il CSV sul tuo Mac”.
- Non copiare `data/accounts/<CF>/storage_state.json` tra account.
- Non loggare URL autologin interi (il logger redige).
- Non mettere `members.db` in zip pubblici “anonimi” se il pacchetto esce dall’org (prepare-package **mantiene** members.db per i colleghi autorizzati).

### Rotazione token (maintainer)

1. CSV aggiornato dalla piattaforma **oppure** aggiornamento puntuale.
2. `node scripts/import-members.js "<csv>"` (o update manuale DB).
3. Commit + push di `data/members.db`.
4. I colleghi: “Aggiorna e avvia”; se serve, `set-active <CF>` / ri-scelta Chi sei?.

## PINNED_TAG (install immutabile)

In `install.sh`:

```bash
PINNED_TAG=""   # es. "v1.1.0"
```

- Se valorizzato, primo clone su quel tag.
- Documentato per store che vogliono freeze di codice (il DB membri continua ad aggiornarsi se pushano `members.db` su quel tag — di solito si pinna il codice e si aggiorna main).

## Share metriche (opt-in)

- `config.shareMetrics: true` → `metrics-cli share`
- Solo conteggi phase / storeTag — **no** CF nel payload remoto

## Coda multi-membro

```json
"memberQueue": ["CF1", "CF2"]
```

CF devono esistere in `members.db` (già sul Mac). A fine corsi avanza al prossimo.
