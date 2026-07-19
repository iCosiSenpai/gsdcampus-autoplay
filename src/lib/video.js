const { SessionError, OffHoursExit } = require('./errors');
const { isLoginPage } = require('./page-detect');

// Contratto completamento (scrape 07/2026, player Video.js / vjs-tech):
//  1) evento HTMLMediaElement 'ended' (più reattivo del solo poll)
//  2) currentTime >= duration - 1.5s  (non uscire al 95%: la piattaforma
//     salva la posizione e riparte da lì → lezione bloccata al 93-94%)
//  3) % DOM solo se candidati NON-vjs e in scope del video (anti falso 100% buffer)
// Nessun candidato DOM → ok: restano (1)+(2)+check post-video su pagina corso.

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
}

module.exports = {
  watchVideo,
  formatTime,
  parsePlayerPctText,
  isVideoNearEnd,
  isDomPctComplete,
  shouldFinishVideo,
  videoPollMs,
  NEAR_END_SEC,
  POLL_MS,
  POLL_NEAR_END_MS,
};
