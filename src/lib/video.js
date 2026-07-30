const { SessionError, OffHoursExit } = require('./errors');
const { isLoginPage } = require('./page-detect');

// Contratto completamento (scrape 07/2026, player Video.js / vjs-tech):
//  1) evento HTMLMediaElement 'ended' (più reattivo del solo poll)
//  2) currentTime >= duration - 1.5s  (non uscire al 95%: la piattaforma
//     salva la posizione e riparte da lì → lezione bloccata al 93-94%)
//  3) % DOM solo se candidati NON-vjs e in scope del video (anti falso 100% buffer)
// Nessun candidato DOM → ok: restano (1)+(2)+check post-video su pagina corso.

// La piattaforma **salva la posizione a intervalli**, non alla fine del video. Uscire
// appena il video termina lascia registrata la penultima posizione: la lezione resta
// appena sotto il 100% e il suo cancello non si apre più.
//
// Visto sul corso 19568, lezione 14241: video di 15:33 guardato fino a 15:32, «Video
// finito», e sulla pagina corso 96,04% per sempre. Il 96,04% non era un caso: 14:57 su
// 15:33: l'ultimo salvataggio, scattato una trentina di secondi prima della fine. Tre
// tentativi identici, poi la lezione dichiarata bloccata — e con lei l'intero corso,
// perché la piattaforma svela il contenuto a blocchi.
const REGISTERED_PROGRESS_SEL = '#avanzamento-registrato';
/** Quanto si resta sulla pagina ad aspettare che la fine venga registrata. */
const PERSIST_MAX_WAIT_MS = 120000;
const PERSIST_POLL_MS = 5000;
/** Tolleranza: la posizione registrata non arriva al secondo esatto della durata. */
const PERSIST_EPSILON_SEC = 3;

const NEAR_END_SEC = 1.5;
const POLL_MS = 30000;
const POLL_NEAR_END_MS = 2000;
const NEAR_END_WINDOW_SEC = 10;

function formatTime(t) {
  if (!isFinite(t)) return '--:--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Pure: secondi da un testo `hh:mm:ss` o `mm:ss`.
 * @returns {number|null} null se non interpretabile
 */
function parseClockToSeconds(text) {
  const txt = String(text || '').trim();
  const m = txt.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  if (min > 59 || sec > 59) return null;
  return h * 3600 + min * 60 + sec;
}

/**
 * Pure: la posizione registrata dalla piattaforma copre la fine del video?
 * @param {number|null} registeredSec posizione salvata
 * @param {number|null} durationSec durata del video
 * @returns {boolean}
 */
function isProgressRegistered(registeredSec, durationSec, epsilon = PERSIST_EPSILON_SEC) {
  if (!Number.isFinite(registeredSec) || !Number.isFinite(durationSec)) return false;
  if (durationSec <= 0) return false;
  return registeredSec >= durationSec - epsilon;
}

/** Pure: parse % da testo corto del player (non paragrafi lunghi). */
function parsePlayerPctText(t) {
  const txt = String(t || '').trim();
  if (!txt || txt.length > 20) return null;
  const m = txt.match(/(\d{1,3})(?:[.,]\d+)?\s*%/);
  return m ? parseInt(m[1], 10) : null;
}

/** Pure: true se currentTime è a ridosso della fine reale. */
function isVideoNearEnd(currentTime, duration, epsilonSec = NEAR_END_SEC) {
  return Number.isFinite(duration) && duration > 0
    && Number.isFinite(currentTime)
    && currentTime >= duration - epsilonSec;
}

/** Pure: % DOM sufficiente a considerare completato. */
function isDomPctComplete(domPct) {
  return domPct !== null && domPct !== undefined && Number(domPct) >= 99;
}

/**
 * Pure: decisione di fine video da flag.
 * @param {{ ended?: boolean, nearEnd?: boolean, domComplete?: boolean }} f
 */
function shouldFinishVideo(f = {}) {
  return !!(f.ended || f.nearEnd || f.domComplete);
}

/** Pure: intervallo poll — vicino alla fine più frequente. */
function videoPollMs(currentTime, duration) {
  if (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime)
      && currentTime >= duration - NEAR_END_WINDOW_SEC) {
    return POLL_NEAR_END_MS;
  }
  return POLL_MS;
}

// Rimette in play il <video> corrente (mute + play). In headless il player viene
// spesso messo in pausa dal throttle del tab o dall'heartbeat della piattaforma.
async function ensurePlaying(page) {
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      if (v.paused) v.play();
    }
  }).catch(() => {});
}

/** Installa flag window.__gsdVideoEnded sull'elemento video (dopo load/reload). */
async function installEndedListener(page) {
  await page.evaluate(() => {
    window.__gsdVideoEnded = false;
    const v = document.querySelector('video');
    if (!v) return;
    if (v.ended) {
      window.__gsdVideoEnded = true;
      return;
    }
    // Rimuovi listener precedenti se rieseguito (reload).
    if (window.__gsdVideoEndedHandler) {
      try { v.removeEventListener('ended', window.__gsdVideoEndedHandler); } catch (_) {}
    }
    window.__gsdVideoEndedHandler = () => { window.__gsdVideoEnded = true; };
    v.addEventListener('ended', window.__gsdVideoEndedHandler);
  }).catch(() => {});
}

async function readEndedFlag(page) {
  return await page.evaluate(() => !!window.__gsdVideoEnded).catch(() => false);
}

// Aspetta che il <video> rimonti dopo un reload.
async function waitForVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function readVideoStatus(page) {
  return await page.evaluate(() => {
    const v = document.querySelector('video');
    let domPct = null;
    const parsePct = (t) => {
      const txt = String(t || '').trim();
      if (!txt || txt.length > 20) return null;
      const m = txt.match(/(\d{1,3})(?:[.,]\d+)?\s*%/);
      return m ? parseInt(m[1], 10) : null;
    };
    const sel = '[class*="percent"], [class*="progress"], [class*="avanzamento"], [class*="fruizione"]';
    const cands = [...document.querySelectorAll(sel)]
      .filter(el => !/(^|\s)vjs-/.test(String(el.className || '')))
      .map(el => ({ el, pct: parsePct(el.innerText) }))
      .filter(c => c.pct !== null);
    if (cands.length && v) {
      let scope = v.parentElement;
      for (let i = 0; i < 4 && scope && !cands.some(c => scope.contains(c.el)); i++) {
        scope = scope.parentElement;
      }
      const inScope = scope ? cands.filter(c => scope.contains(c.el)) : [];
      if (inScope.length) domPct = inScope[0].pct;
    }
    if (domPct === null && cands.length === 1) domPct = cands[0].pct;
    return {
      status: v ? { ended: v.ended, t: v.currentTime, d: v.duration } : null,
      domPct,
      flagEnded: !!window.__gsdVideoEnded,
    };
  }).catch(() => ({ status: null, domPct: null, flagEnded: false }));
}

async function watchVideo(page, log, monitor, shiftCheck) {
  log('Video in corso...');
  await ensurePlaying(page);
  await installEndedListener(page);

  let finished = false;
  let lastTime = -1;
  let lastDuration = NaN;
  let freezeCount = 0;
  let reloadCount = 0;
  const MAX_RELOADS = 3;
  const startedAt = Date.now();
  const MAX_WATCH_MS = 3 * 60 * 60 * 1000; // 3 ore

  while (!finished) {
    await page.waitForTimeout(videoPollMs(lastTime, lastDuration));

    if (shiftCheck) {
      const s = shiftCheck.evaluate();
      if (s.extraTimeArmed) log(`Turno appena terminato. Extra-time fino alle ${s.extraTimeUntil ? new Date(s.extraTimeUntil).toISOString() : 'N/A'} per completare il video in corso.`);
      if (s.stop) {
        log(`Fine turno durante il video (extra-time scaduto). Esco graceful: la piattaforma salva la posizione, lo scheduler riprederà al prossimo turno.`);
        throw new OffHoursExit('Fine turno durante il video');
      }
    }

    if (Date.now() - startedAt > MAX_WATCH_MS) {
      log('Tetto massimo tempo video raggiunto (3h). Passo al contenuto successivo.');
      break;
    }

    // Flag ended (listener) — non aspetta il prossimo poll lungo.
    if (await readEndedFlag(page)) {
      log('Video completato (evento ended).');
      finished = true;
      break;
    }

    const result = await readVideoStatus(page);
    const { status, domPct, flagEnded } = result;

    if (!status) {
      log('Video element scomparso, esco.');
      break;
    }

    lastDuration = status.d;
    monitor?.update({ phase: 'video', videoProgress: `${formatTime(status.t)} / ${formatTime(status.d)}` });
    log(`Video: ${formatTime(status.t)} / ${formatTime(status.d)}` + (domPct !== null ? ` (DOM: ${domPct}%)` : ''));

    if (shouldFinishVideo({
      ended: status.ended || flagEnded,
      nearEnd: isVideoNearEnd(status.t, status.d),
      domComplete: isDomPctComplete(domPct),
    })) {
      if (isDomPctComplete(domPct) && !status.ended && !flagEnded && !isVideoNearEnd(status.t, status.d)) {
        log(`Video considerato completato dalla percentuale DOM (${domPct}%).`);
      } else if (status.ended || flagEnded) {
        log('Video completato (ended).');
      }
      finished = true;
      break;
    }

    if (status.t === lastTime) {
      freezeCount++;
      await ensurePlaying(page);
      log(`Video progress stalled. Freeze count: ${freezeCount}/3`);
      if (freezeCount >= 3) {
        reloadCount++;
        if (reloadCount > MAX_RELOADS) {
          log('MAX_RELOADS reached. Giving up on this video and moving to next content.');
          break;
        }
        log(`Video frozen detected! Recovery action: reloading page (Attempt ${reloadCount}/${MAX_RELOADS})...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const remounted = await waitForVideo(page, 30000);
        if (remounted) {
          await ensurePlaying(page);
          await installEndedListener(page);
        } else {
          if (await isLoginPage(page).catch(() => false)) {
            throw new SessionError('Sessione caduta durante la riproduzione del video (redirect a /login dopo reload).');
          }
          log('Video non rimontato dopo reload (causa ignota). Esco.');
        }
        freezeCount = 0;
        lastTime = -1;
      }
    } else {
      lastTime = status.t;
      freezeCount = 0;
      reloadCount = 0;
    }
  }

  monitor?.update({ videoProgress: 'finished' });
  log('Video finito.');

  // Non si esce subito: si aspetta che la piattaforma **registri** la fine.
  //
  // È la correzione del difetto descritto in testa al file. Andarsene appena il video
  // termina lascia salvata la penultima posizione, e la lezione resta bloccata appena
  // sotto il 100% senza che nessun tentativo successivo possa rimediare — perché al
  // ritorno il video riprende già in fondo, dura pochi secondi, e nessun salvataggio
  // scatta in quella finestra.
  if (finished) {
    await waitForRegisteredProgress(page, log, lastDuration);
  }
}

/**
 * Resta sulla pagina finché la piattaforma non registra la fine del video.
 *
 * Difensiva per scelta: se l'indicatore non c'è, o la durata non è nota, **non blocca** —
 * aspettare all'infinito su una pagina che non dice niente sarebbe peggio del difetto che
 * si vuole correggere. Si ferma anche quando la posizione registrata smette di crescere,
 * per non consumare due minuti a vuoto.
 */
async function waitForRegisteredProgress(page, log, durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return false;

  const read = async () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.textContent || '').trim() : null;
  }, REGISTERED_PROGRESS_SEL).catch(() => null);

  const first = await read();
  if (first === null) {
    // Nessun indicatore su questa pagina: non c'è niente da attendere.
    return false;
  }

  const startedAt = Date.now();
  let best = parseClockToSeconds(first) ?? 0;
  let stalledPolls = 0;

  if (isProgressRegistered(best, durationSec)) {
    log(`Fine già registrata dalla piattaforma (${first}).`);
    return true;
  }
  log(`Attendo che la piattaforma registri la fine (ora ${first}, durata ${formatTime(durationSec)}).`);

  while (Date.now() - startedAt < PERSIST_MAX_WAIT_MS) {
    await page.waitForTimeout(PERSIST_POLL_MS);
    const text = await read();
    const seconds = parseClockToSeconds(text);

    if (isProgressRegistered(seconds, durationSec)) {
      log(`Fine registrata dalla piattaforma (${text}).`);
      return true;
    }
    if (Number.isFinite(seconds) && seconds > best) {
      best = seconds;
      stalledPolls = 0;
    } else {
      stalledPolls++;
      // Tre letture identiche: la piattaforma non sta più salvando. Insistere non
      // cambierebbe niente e ruberebbe tempo alle altre lezioni.
      if (stalledPolls >= 3) {
        log(`La posizione registrata non cresce più (${text}): smetto di attendere.`);
        return false;
      }
    }
  }
  log('Tempo di attesa esaurito: la fine non risulta registrata.');
  return false;
}

module.exports = {
  watchVideo,
  formatTime,
  parsePlayerPctText,
  isVideoNearEnd,
  isDomPctComplete,
  shouldFinishVideo,
  videoPollMs,
  parseClockToSeconds,
  isProgressRegistered,
  NEAR_END_SEC,
  POLL_MS,
  POLL_NEAR_END_MS,
};
