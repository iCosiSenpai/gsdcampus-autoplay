/**
 * status-reconcile.js — allinea logs/status.json alla realtà dei processi.
 *
 * Problema: running:true e phase "video"/"quiz" restano su disco dopo crash,
 * stop incompleto o smoke test Monitor → l'AI crede che il corso giri ancora.
 *
 * Se nessuno scheduler/autoplay è vivo: running=false e phase attive → stopped.
 * Se un processo è vivo: no-op.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeJsonAtomic, readJsonSafe } = require('./io');
const { inspectLock } = require('./runtime-lock');

/** Fasi che indicano un run IN CORSO (non terminali). */
const ACTIVE_PHASES = new Set([
  'starting',
  'checking',
  'lesson',
  'video',
  'quiz',
  'quiz_dashboard',
  'quiz_needs_answers',
  // residuali / smoke
  'running',
]);

/** Fasi terminali: non le rinominiamo (restano informative). */
const TERMINAL_PHASES = new Set([
  'stopped',
  'done',
  'need_help',
  'awaiting_ai',
  'complete',
  'off_hours',
  'fatal',
  'idle',
  'autologin_invalid',
  'session_lost',
  'session_unstable',
  'post_login_blocked',
  'crash_loop',
  'preflight_failed',
  'error',
  'all_need_help',
]);

function isActivePhase(phase) {
  if (phase == null || phase === '') return false;
  const p = String(phase);
  if (TERMINAL_PHASES.has(p)) return false;
  if (ACTIVE_PHASES.has(p)) return true;
  // Sconosciuta ma running: trattala come attiva se non terminale
  return true;
}

/**
 * Quanto puo' essere vecchio logs/status.json e valere ancora come «qualcuno lo sta
 * scrivendo». La app e lo scheduler battono ogni ~30 s: novanta secondi sono tre battiti
 * mancati, cioe' un'assenza, non un ritardo.
 */
const FRESH_WINDOW_MS = 90 * 1000;

/**
 * Pure: riconcilia un oggetto status in memoria.
 * @param {object} status
 * @param {{ processAlive: boolean, forceStopped?: boolean, now?: Date }} opts
 * @returns {{ status: object, changed: boolean, reason: string|null }}
 */
function reconcileStatusObject(status, opts = {}) {
  // forceStopped: dopo stop.sh, non fidarsi di pgrep residui.
  const processAlive = opts.forceStopped ? false : !!opts.processAlive;
  const base = status && typeof status === 'object' ? { ...status } : {};
  let changed = false;
  let reason = null;

  if (processAlive) {
    return { status: base, changed: false, reason: null };
  }

  // Uno stato APPENA scritto non si corregge, qualunque cosa dicano i processi.
  //
  // Chi scrive un file adesso e' vivo adesso: e' la prova piu' diretta che esista, piu'
  // diretta di qualunque riconoscimento di processo — che invece dipende dal sapere COME si
  // chiama il motore, e quindi sbaglia ogni volta che il motore cambia.
  //
  // Il caso misurato il 3 agosto 2026: con la app nativa che stava guardando una lezione,
  // nessuno dei riconoscimenti qui sotto la vedeva — non e' un processo Node, non e'
  // scheduler.sh — e `status.sh` RISCRIVEVA il file con `running: false, phase: "stopped"`
  // mentre il video avanzava e i salvataggi tornavano 200.
  //
  // Il danno non e' la riga sbagliata a schermo: quel file e' la fonte da cui l'AI
  // supervisore capisce se l'automazione lavora. Letto in quella finestra dice «ferma», e la
  // conclusione naturale e' avviarla — cioe' aprire una SECONDA sessione sulla piattaforma,
  // che spegne i salvataggi di quella in corso.
  //
  // Con la freschezza la regola diventa indipendente da chi e' il motore, oggi e domani.
  //
  // Tranne con `forceStopped`, che e' il caso opposto: la' chi chiama SA di aver appena
  // fermato tutto, e un file fresco e' proprio quello che l'automazione ha scritto un
  // istante prima di morire. Fidarsi della freschezza li' significherebbe non riconciliare
  // mai dopo uno stop.
  const lastUpdate = Date.parse(base.lastUpdate || '');
  const now = (opts.now instanceof Date ? opts.now : new Date()).getTime();
  if (
    !opts.forceStopped
    && Number.isFinite(lastUpdate)
    && now - lastUpdate >= 0
    && now - lastUpdate < FRESH_WINDOW_MS
  ) {
    return { status: base, changed: false, reason: 'fresh_writer' };
  }

  // Processo non vivo.
  if (base.running) {
    base.running = false;
    changed = true;
    reason = 'running_orphaned';
  }

  if (base.schedulerRunning) {
    base.schedulerRunning = false;
    changed = true;
    reason = reason || 'scheduler_orphaned';
    if (base.phase === 'off_hours' || base.phase === 'scheduler_starting' || base.phase === 'scheduler_launching' || base.phase === 'awaiting_ai') {
      base.phase = 'stopped';
    }
  }

  if (isActivePhase(base.phase)) {
    base.phase = 'stopped';
    changed = true;
    reason = reason || 'active_phase_orphaned';
  }

  // running false ma phase attiva e status vecchio: stessa correzione
  // (già coperto da isActivePhase sopra)

  if (changed) {
    base.lastUpdate = new Date().toISOString();
    base.note = 'Processo non attivo: status riconciliato (running/phase non riflettevano un run vivo).';
  }

  return { status: base, changed, reason };
}

/**
 * Il processo della app nativa, com'e' scritto da `ps`:
 *
 *   /Applications/Autoplay San.app/Contents/MacOS/Autoplay San
 *
 * Si ancora al percorso dentro il bundle e non al solo nome: «Autoplay San» da solo
 * matcherebbe anche una riga di terminale che parla della app — per esempio un `tail` sul
 * suo diario, o questo stesso commento aperto in un editor.
 */
const APP_PROCESS_RE = /Autoplay San\.app\/Contents\/MacOS\//;

/** Il pid che la app dichiara in logs/status.json, se c'e'. */
function readAppPid(root) {
  const status = readJsonSafe(path.join(root, 'logs', 'status.json'), null);
  const pid = status && Number(status.pid);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readPidFile(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.autoplay_pid'), 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function commandForPid(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return String(out || '').trim();
  } catch (_) {
    return '';
  }
}

function pidAliveMatching(pid, patternRe) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }
  const cmd = commandForPid(pid);
  if (!cmd) return false;
  return patternRe.test(cmd);
}

/**
 * True se gira scheduler o autoplay.js (path-indipendente).
 * Non matcha autoplay.log.
 */
function isAnyAutomationAlive(root) {
  const r = root || path.join(__dirname, '..', '..');
  try {
    if (inspectLock(r).alive) return true;
  } catch (_) { /* fallback legacy sotto */ }
  const pid = readPidFile(r);
  if (pidAliveMatching(pid, /scheduler|autoplay\.js/i)) return true;

  // La app nativa è automazione quanto lo scheduler, e non si vedeva.
  //
  // Il motore che apre le pagine può essere `node autoplay.js` oppure la app: nel secondo
  // caso non esiste nessun processo Node, `.autoplay_pid` non c'entra, e nessuno dei
  // pattern qui sopra combacia. Il risultato misurato il 3 agosto 2026: con la app che
  // stava guardando una lezione — video che avanzava, salvataggi HTTP 200 — questa
  // funzione rispondeva `false`, e `status.sh` **riscriveva** logs/status.json con
  // `running: false, phase: "stopped"`.
  //
  // Non è un dettaglio di visualizzazione. Quel file è la fonte da cui l'AI supervisore e
  // gli avvisi capiscono se l'automazione lavora: letto in quella finestra dice «ferma», e
  // la conclusione naturale è avviarla — cioè aprire una SECONDA sessione sulla
  // piattaforma, che è il guasto che spegne i salvataggi di quella in corso. Il file si
  // ripara da sé al battito successivo della app, una trentina di secondi dopo, ma in
  // quella trentina di secondi dice una cosa falsa e invita a fare la cosa sbagliata.
  //
  // Il pid della app lo dichiara la app stessa in logs/status.json. Va verificato in due
  // passaggi — vivo E con il nome giusto — perché un pid vecchio, dopo un riavvio, può
  // essere stato riassegnato a un processo qualunque.
  if (pidAliveMatching(readAppPid(r), APP_PROCESS_RE)) return true;

  // Fallback: scansiona processi (macOS/Linux).
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      if (/autoplay\.js/.test(cmd) && !/autoplay\.log/.test(cmd)) return true;
      if (/scheduler\.sh/.test(cmd)) return true;
    }
  } catch (_) { /* ps non disponibile */ }

  return false;
}

/**
 * Legge e, se serve, riscrive logs/status.json.
 * @param {string} root
 * @param {{ processAlive?: boolean, forceStopped?: boolean }} [opts]
 *   Se processAlive è undefined, viene calcolato con isAnyAutomationAlive.
 */
function reconcileStatusFile(root, opts = {}) {
  const r = root || path.join(__dirname, '..', '..');
  const statusPath = path.join(r, 'logs', 'status.json');
  const current = readJsonSafe(statusPath, null);
  if (!current || typeof current !== 'object') {
    return { changed: false, status: current, reason: null };
  }

  let processAlive = opts.processAlive;
  if (opts.forceStopped) processAlive = false;
  else if (processAlive === undefined) processAlive = isAnyAutomationAlive(r);

  const { status, changed, reason } = reconcileStatusObject(current, {
    processAlive: !!processAlive,
    forceStopped: !!opts.forceStopped,
  });

  if (changed) {
    try {
      writeJsonAtomic(statusPath, status);
    } catch (_) {
      return { changed: false, status: current, reason: 'write_failed' };
    }
  }
  return { changed, status, reason };
}

module.exports = {
  ACTIVE_PHASES,
  TERMINAL_PHASES,
  APP_PROCESS_RE,
  FRESH_WINDOW_MS,
  isActivePhase,
  reconcileStatusObject,
  reconcileStatusFile,
  isAnyAutomationAlive,
  pidAliveMatching,
  readAppPid,
};
