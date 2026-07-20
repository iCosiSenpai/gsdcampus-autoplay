# Runbook sessione — per tutti gli store

## `session_unstable` ≠ link scaduto

| Fase | Significato | Cosa fare |
|------|-------------|-----------|
| `session_unstable` | Autologin **valido**, piattaforma rate-limita i re-login | Aspetta cooldown (default 30 min, `sessionUnstableCooldownMin`) e `./start.sh`. **Non** chiedere nuovo link. |
| `autologin_invalid` | Sonda live fallita **oppure** stato vecchio | Prima `healthcheck-cli.js`. Se NON valido: `set-active` da members.db / «Aggiorna e avvia» se il DB è stato rinfrescato; CSV solo per il maintainer che aggiorna il DB. |
| `session_lost` | Cookie/sessione caduta mid-run | Come unstable se token già provato valido nel run. |
| `need_help` | Quiz sospeso (domande da risolvere) | AI: WebSearch → `answers-cli resolve` (auto-share) → `resetCourse` → start. |

## Cooldown

```json
"sessionUnstableCooldownMin": 30
```

Store lenti / molti hit: 45–60.

## Chrome vs Chromium

- Chrome di sistema **consigliato**.
- Senza Chrome, Playwright Chromium funziona (fallback automatico).

## Un Mac, più colleghi

```bash
node scripts/lib/members-cli.js queue set CF1 CF2 CF3
./start.sh
```

A fine corsi di CF1 → config sul prossimo → scheduler riparte ~60s.
