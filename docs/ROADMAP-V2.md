# Roadmap V2 — gsdcampus-autoplay (post A–D)

**Data:** 2026-07-19  
**Membro di riferimento (live scrape):** ALESSIO COSI (`CSOLSS95L23D862R`)  
**Commit base:** `554010c` (test, split moduli, share Worker, metrics/probes)  
**Scopo:** piano *mega-dettagliato* di cosa si può ancora fare, in **step ordinati**, con priorità, evidenze dalla piattaforma e criteri di done.  
**Come usarlo:** si affonda **uno step alla volta** (come A→B→C→D). Non implementare tutto in blocco.

---

## 0. Snapshot attuale (evidenze)

### 0.1 Stato account Alessio (live 2026-07-19)

| Voce | Valore |
|------|--------|
| Login autologin | **OK** → dashboard `listAllByUser` |
| Corsi in dashboard | **7** (link `/corso/show/*`) |
| Done con quiz superato (stato locale 17/07) | 8122, 15580, 16146, 16983 |
| In corso / da fare | **18387** (~27%), **18949** (0%), **19568** (0%) |
| Banca trusted | 40 risposte (= public, allineate) |
| Handoff AI quiz | 0 domande aperte (file vuoto/stale reason harvest) |
| Orario | lun–ven 09:00–13:00 e 16:00–20:00 |
| Scheduler | non attivo al momento del check |
| Chrome di sistema | **assente** su questo Mac → `channel: 'chrome'` fallisce |

### 0.2 Cosa ha mostrato lo scrape live (DOM reale)

Dump in `debug/exploration/CSOLSS95L23D862R_live/` (gitignored). Sintesi:

| Pagina | Trova |
|--------|--------|
| **Dashboard** | 7 card, 7 `a[href*="/corso/show/"]`, titoli lunghi nel body, ma il blocco vicino al link “Apri” **non espone la %** (closest → solo “Apri”). **Bug di parsing % da dashboard.** |
| **Corso** (es. 8122) | **71** lezioni, **2** questionari, % lezione nel blocco riga (“100.00 %”), informativa nel testo |
| **Lezione** | `<video class="vjs-tech">` + Video.js; `src=/video/get/<id>.mp4?token=…`; **nessun** candidato `%` UI fuori da vjs (lista vuota) → completezza dipende da `currentTime`/`duration` + check post su pagina corso |
| **Quiz (già superato)** | No form attivo; testo “Questionario superato! … Voto finale 24 / 30” → `detectOutcomeFromText` deve coprire questo pattern (già in gran parte) |
| **Dichiarazione fruizione** | Appare entrando in corso (`usageDeclarationVisible: true`) |

### 0.3 Cosa è già solido (non rifare da zero)

- Quiz attempt-protective + trust-by-location  
- Share risposte senza push (`POST /answers` Worker + PAT Contents)  
- Test unitari (87) + CI + dev-check  
- Split `quiz-match` / `login-flow`  
- Metrics phase privacy-safe + selector fixture probe + età status  
- Harvester / reconcile / census / AI todo  

### 0.4 Debito critico emerso oggi

1. **`channel: 'chrome'` obbligatorio** → su Mac senza Google Chrome autoplay/healthcheck muoiono; Playwright Chromium bundled funziona.  
2. **% corsi da dashboard** fragile (closest troppo stretto).  
3. **status.json sporcato** da smoke test Monitor (fase `quiz` corso `99` fantasma).  
4. **Censimento vecchio** (giorni) se non si rilancia harvest.  
5. **Video % UI assente** → rischio regressioni se si tocca `video.js` senza test.  
6. **Token video in URL** (`/video/get/…?token=`) — non loggare `src` grezzo.

---

## Come leggere le priorità

| Prio | Significato |
|------|-------------|
| **P0** | Blocca o rischia di bloccare i Mac dei colleghi / runtime |
| **P1** | ROI alto su completamento corsi o stabilità |
| **P2** | Qualità / scala / DX |
| **P3** | Nice-to-have / fleet / prodotto |

Ogni **STEP** è un “ticket” autonomo: obiettivo, lavoro, test, done, rischi.

---

# FASE 1 — Stabilizzazione runtime (P0)

## STEP 1.1 — Browser launcher resiliente ✅ DONE (2026-07-19)

**Problema:** `channel: 'chrome'` falliva senza Chrome.app.  
**Soluzione:** `src/lib/browser.js` → auto chrome poi Chromium bundled; config `browserChannel`; wired in autoplay/healthcheck/harvest/explore; requirements non bloccano se c’è Chromium.

**Done**
- [x] Healthcheck su Mac solo-Playwright.
- [x] Log/backend esplicito.
- [x] Test `test/browser.test.js`.

**Rischio residuo:** fingerprint Chromium → monitorare session_unstable.

---

## STEP 1.2 — Pulizia stato sporchato + guardie status ✅ DONE (2026-07-19)

**Problema:** `running:true` / phase video|quiz orfani senza processo.  
**Soluzione:** `src/lib/status-reconcile.js` + `status-cli reconcile`; wired in status/stop/start.

**Done**
- [x] Dopo status/stop, niente `running=true` orfano.
- [x] Test pure `test/status-reconcile.test.js`.

---

## STEP 1.3 — Parsing % dashboard robusto ✅ DONE (2026-07-19)

**Problema:** census usava `(aria-label || style).match(%)` ma aria è la ditta → pct null.  
**Soluzione:** `src/lib/dashboard-parse.js` legge `style width: N%` prima; census + discoverCourses.

**Done**
- [x] Fixture + test 100 / 30.51 / 0.
- [x] Live dump Alessio: 4×100, 18387≈30.51, 2×0.

---

## STEP 1.4 — Non loggare token video ✅ DONE (2026-07-19)

**Problema:** dump HTML grezzi contenevano `video/get/…?token=`. I log di riga erano già redatti.  
**Soluzione:** `redactSensitiveText` + dump monitor/quiz redatti; test video+HTML.

**Done**
- [x] Test URL video e HTML.
- [x] Dump debug redatti.

---

# FASE 2 — Completamento account Alessio (P1, operativo)

Non è “feature codice”: è **lavoro supervisore** + piccoli fix se bloccato.

## STEP 2.1 — Orientamento fresco

```bash
# in orario o --ignore-hours solo se chiesto
node scripts/harvest-answers.js --all
./status.sh
node scripts/lib/metrics-cli.js summary
```

**Done:** `course_census.json` < 15 min; `ai_todo` aggiornato.

## STEP 2.2 — Harvest domande quiz corsi aperti

Focus corsi **18387, 18949, 19568** (e questionari pendenti).

```bash
node scripts/harvest-answers.js --to-ai-request
# resolve batch → share
./scripts/publish-answers.sh
```

**Done:** domande dei quiz finali di quei moduli in trusted (o documentate se materiale-corso-only).

## STEP 2.3 — Run autoplay

```bash
./start.sh   # rispetta turni
# Monitor grep eventi
```

**Done:** 18387 → 100% + quiz; poi 18949; poi 19568; attestati se richiesti.

## STEP 2.4 — Reconcile falsi-done

```bash
node scripts/harvest-answers.js --reconcile --reset
```

**Done:** nessun corso 100% video con questionario ancora aperto segnato `done`.

---

# FASE 3 — Video player & lezioni (P1)

## STEP 3.1 — Contratto video basato su scrape ✅ DONE (2026-07-19)

**Soluzione:** helper pure + flag `ended` su window + poll 2s negli ultimi 10s; test `test/video.test.js`.

**Done**
- [x] Contratto documentato in video.js.
- [x] Evento ended + near-end poll.
- [x] Test pure.

## STEP 3.2 — Less waitForTimeout in video/corso ✅ DONE (2026-07-19)

**Lavoro:** costanti in `platform.js` (`PROGRESS_PERSIST_MS=8000`, …); dove possibile `waitForSelector` / `waitForURL`.

**Done**
- [x] Costanti in `platform.js` + wiring autoplay/login-flow/quiz/course-runner.

## STEP 3.3 — Lezioni non-video (PDF / scorm / testo) ✅ DONE (2026-07-19)

**Done**
- [x] `handleNonVideoLesson` in `course-runner.js` (completa/PDF → skip esplicito dopo 3 tentativi).

---

# FASE 4 — Quiz & banca risposte (P1)

## STEP 4.1 — Coverage banca vs quiz reali

**Lavoro**
1. Harvester su tutti i questionari non superati di Alessio + 1 collega.
2. Diff: domande harvest ∉ known_answers.
3. Batch resolve + share.

**Metriche target:**  
- % quiz finalizzati al primo colpo (da metrics: phase quiz → done senza need_help).

## STEP 4.2 — Matching avanzato (dopo più dati)

Solo se 4.1 mostra falsi miss:
- normalizzazione sinonimi (“secondo le fonti”…)
- embedding opzionale (Ollama) **solo** come suggerimento, mai auto-promote

## STEP 4.3 — Share robusto oltre 50 entry ✅ DONE (2026-07-19)

**Done**
- [x] `chunkEntries` + multi-POST; `share --all` senza cap 50.

## STEP 4.4 — Outcome quiz: storico tentativi ✅ DONE (2026-07-19)

**Done**
- [x] Test snippet live “9° tentativo… 24/30” in `quiz-outcome.test.js`.

---

# FASE 5 — Architettura codice (P1/P2)

## STEP 5.1 — Split `course-runner` da autoplay ✅ DONE (2026-07-19)

**Done**
- [x] `src/lib/course-runner.js` + autoplay ~550 LOC.

## STEP 5.2 — Split quiz-solve / quiz-handoff ✅ DONE (2026-07-19)

**Done**
- [x] `quiz-bank.js`, `quiz-handoff.js`, `quiz-outcome.js`; `quiz.js` re-export + solve.

## STEP 5.3 — Usare `selectors.js` nei call-site ✅ DONE (2026-07-19)

**Done**
- [x] Quiz form/options + course/lesson link helpers in course-runner.

## STEP 5.4 — setup.sh modular ✅ DONE (parziale 2026-07-19)

**Done**
- [x] `scripts/setup/package-hash.sh` sourced da setup + check-requirements.
- [ ] Split completo deps/ollama/whoareyou (follow-up).

---

# FASE 6 — Multi-membro & fleet (P2)

## STEP 6.1 — Coda multi-CF su un Mac ✅ DONE (2026-07-19)

**Done**
- [x] `member-queue.js` + advance su AllCoursesNeedHelpExit; `config.memberQueue`.

## STEP 6.2 — Dashboard aggregata utile ✅ DONE (2026-07-19)

**Done**
- [x] `lastPhase`, `statusAgeMin`, `needHelp`, running sul membro attivo
- [x] `dashboard-cli list` arricchito + `csv [path]`

## STEP 6.3 — Metrics aggregate opzionali (privacy) ✅ DONE (2026-07-19)

**Done**
- [x] Worker `POST /metrics` + `metrics-cli share` + opt-in `shareMetrics`.

---

# FASE 7 — Affidabilità sessione (P1)

## STEP 7.1 — Meno stress sessione ✅ DONE (2026-07-19)

**Done**
- [x] `session-policy.js` + cooldown configurabile (`sessionUnstableCooldownMin`)
- [x] `isOnDashboardUrl` evita goto ridondanti in course-runner
- [ ] Pool cookie storage_state (deliberatamente non: contesto pulito resta default)

## STEP 7.2 — Telemetria session ✅ DONE (2026-07-19)

**Done**
- [x] metrics `loginDrop` / `missingPermission` + errorClass su phase session

## STEP 7.3 — Chrome headless fingerprint

Se session_unstable aumenta con Chromium bundled:  
provare `channel: chrome` quando disponibile; stealth init script già in explore.
(Browser launcher 1.1 già fa chrome→chromium.)

---

# FASE 8 — Install / ops / sicurezza (P2)

## STEP 8.1 — Requirements: Chrome vs Chromium ✅ DONE (2026-07-19)

**Done**
- [x] Messaggi setup + `browser-check.sh` + check-requirements

## STEP 8.2 — Release pin ✅ DONE (docs 2026-07-19)

- [x] `PINNED_TAG` documentato in `docs/SECURITY-MEMBERS.md` (+ install.sh già supportato)
- [ ] Tag `v1.1.0` quando il maintainer decide il freeze

## STEP 8.3 — members.db audit ✅ DONE (2026-07-19)

- [x] Audit in `docs/SECURITY-MEMBERS.md` (token, gitignore, 0600, consenso)

## STEP 8.4 — Rotazione KEY / PAT ✅ DONE (2026-07-19)

- [x] `docs/RUNBOOK-KEYS.md`

## STEP 8.5 — WAF rate limit Worker ✅ DONE (2026-07-19)

**Done**
- [x] Rate limit in-memory Worker: 10/min answers, 5/min report, 20/min metrics
- [x] Note WAF dashboard in RUNBOOK

---

# FASE 9 — AI supervisore & DX (P2)

## STEP 9.1 — Contratto AI machine-readable ✅ DONE (2026-07-19)

**Done**
- [x] `docs/ai-contract.json` + `test/ai-contract.test.js`

## STEP 9.2 — CLAUDE.md vs Grok ✅ DONE (2026-07-19)

**Done**
- [x] Sezione “Minima autonomia” + link roadmap/contract/security

## STEP 9.3 — JSDoc @ts-check su pure modules ✅ DONE (2026-07-20)

**Done**
- [x] `@ts-check` su quiz-match, metrics, schedule, selectors, session-policy

## STEP 9.4 — Ollama latency ✅ DONE (2026-07-19)

**Done**
- [x] Early-exit se sample1 confidenza ≥ 0.9
- [x] Cache sessione domanda→risposta  

---

# FASE 10 — Prodotto “fleet referente” (P3)

1. Report settimanale automatico (email/Worker): N corsi done / need_help per store (anonimizzato).  
   - **Lite done (2026-07-20):** `node scripts/lib/weekly-report-cli.js [--save]` (locale).  
2. UI locale minima (HTML su `localhost`) per status multi-CF.  
3. Notifiche macOS: estendere a “corso X finito”, “quiz sospeso”.  
   - **Done (2026-07-20):** `src/lib/notify-mac.js` + hook in `monitor.update`.  
4. Mode “solo harvest+resolve” notturno (senza video) per riempire banca.  
   - **Done (2026-07-20):** `./scripts/harvest-night.sh`

## STEP 5.4b / 8.2 — setup modular + tag (tier E)

- [x] `scripts/setup/ollama.sh` + `versions.sh`  
- [x] `package.json` 1.1.0 + tag `v1.1.0` (al push)

---

# Ordine di attacco consigliato (sequenza “approfondiamo”)

| # | Step | Perché adesso |
|---|------|----------------|
| 1 | **1.1 Browser launcher** | Questo Mac (e altri senza Chrome) non partono |
| 2 | **1.2 Status stale** | Evita false diagnosi AI |
| 3 | **1.3 Dashboard %** | Census/discover sbagliati |
| 4 | **2.x Completare Alessio** | Valore business immediato + stress-test |
| 5 | **4.4 + 3.1** test outcome/video da snippet live | Chiude regressioni scrape-driven |
| 6 | **5.1 course-runner** | Manutenibilità |
| 7 | **1.4 redact video token** | Sicurezza log |
| 8 | **4.1 bank coverage** | Meno need_help |
| 9 | **6.1 multi-CF queue** | Un Mac → più operatori |
| 10 | Resto P2/P3 | quando la base è calma |

---

# Template “approfondimento di uno step”

Quando dici “facciamo lo step X.Y”, la sessione deve:

1. **Rileggere** la sezione step (obiettivo + done).  
2. **Esplorare** file toccati (e scrape se DOM).  
3. **Implementare** solo quello step.  
4. **Test** (`npm test`, dev-check, smoke mirato).  
5. **Commit** se chiedi push.  
6. **Aggiornare** questa roadmap: checkbox done + note.

---

# Backlog esplicitamente fuori scope (per ora)

- Accelerare video con playbackRate alto (anti-cheat).  
- Finalizzare quiz con solo Ollama.  
- Edit `src/` dall’AI supervisore in produzione (policy).  
- Rewrite TypeScript completo.  
- Parallelizzare 2 browser stesso account (token burn).

---

# Appendice A — Comandi utili (Alessio)

```bash
# Stato
./status.sh
node scripts/lib/metrics-cli.js summary 48
node scripts/lib/selector-probe.js

# Live (richiede browser funzionante — dopo 1.1 anche senza Chrome.app)
node scripts/lib/healthcheck-cli.js
node scripts/harvest-answers.js --all

# Completamento
./start.sh
# oppure solo se esplicitamente richiesto: ./start.sh --ignore-hours

# Share risposte
./scripts/publish-answers.sh
```

# Appendice B — File scrape live (locale, non commit)

```
debug/exploration/CSOLSS95L23D862R_live/
  live_report.json
  dashboard.html
  course_sample.html
  lesson_sample.html
  quiz_page.html / quiz_active.html
```

# Appendice C — Mappa moduli post A–D

```
src/autoplay.js          orchestrazione (~1k → da snellire)
src/lib/login-flow.js    interstitial / informativa / dichiarazione
src/lib/quiz-match.js    matching banca
src/lib/quiz.js          solve + handoff + bank I/O
src/lib/video.js         player Video.js
src/lib/metrics.js       metrics.jsonl
src/lib/selectors.js     catalogo + probe fixture
worker/issue-receiver.js issue + answers commit
```

---

**Prossimo passo consigliato:** STEP **1.1 — Browser launcher resiliente** (sblocca healthcheck/autoplay su questo Mac e allinea doctor).  
Dimmi pure “facciamo 1.1” (o un altro step) e lo implementiamo in isolamento.
