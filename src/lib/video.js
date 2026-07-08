const { SessionError } = require('./errors');
const { isLoginPage } = require('./page-detect');

function formatTime(t) {
  if (!isFinite(t)) return '--:--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Rimette in play il <video> corrente (mute + play). In headless il player viene
// spesso messo in pausa dal throttle del tab o dall'heartbeat della piattaforma:
// un play() basta a ripartire dallo stesso currentTime. È una recovery molto
// più leggera di un page.reload(), che su sessioni fragili fa rimbalzare su
// /login e consuma il token (vedi memoria sul "sovrauso del token").
async function ensurePlaying(page) {
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      if (v.paused) v.play();
    }
  }).catch(() => {});
}

// Aspetta che il <video> rimonti dopo un reload (la pagina può montarlo in lazy
// o passare da un'interstitial "dichiarazione di fruizione"). Restituisce false
// se entro timeoutMs non c'è, così il chiamante non scambia "video non ancora
// montato" per "video scomparso = lezione finita".
async function waitForVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function watchVideo(page, log, monitor) {
  log('Video in corso...');
  await ensurePlaying(page);

  let finished = false;
  let lastTime = -1;
  let freezeCount = 0;
  let reloadCount = 0;
  const MAX_RELOADS = 3;
  const startedAt = Date.now();
  // Tetto di sicurezza: anche se "ended" non scatta mai (player rotto, duration NaN),
  // non restare bloccati all'infinito su una singola lezione.
  const MAX_WATCH_MS = 3 * 60 * 60 * 1000; // 3 ore

  while (!finished) {
    await page.waitForTimeout(30000);

    if (Date.now() - startedAt > MAX_WATCH_MS) {
      log('Tetto massimo tempo video raggiunto (3h). Passo al contenuto successivo.');
      break;
    }

    const result = await page.evaluate(() => {
      const v = document.querySelector('video');
      // Cerca una percentuale di avanzamento nel DOM (player custom).
      const bodyText = document.body ? document.body.innerText : '';
      const pctMatch = bodyText.match(/(\d{1,3})\s*%/);
      const pct = pctMatch ? parseInt(pctMatch[1], 10) : null;
      return {
        status: v ? { ended: v.ended, t: v.currentTime, d: v.duration } : null,
        domPct: pct
      };
    }).catch(() => ({ status: null, domPct: null }));

    const { status, domPct } = result;

    if (!status) {
      log('Video element scomparso, esco.');
      break;
    }

    monitor?.update({ phase: 'video', videoProgress: `${formatTime(status.t)} / ${formatTime(status.d)}` });
    log(`Video: ${formatTime(status.t)} / ${formatTime(status.d)}` + (domPct !== null ? ` (DOM: ${domPct}%)` : ''));

    // Fonte di verità 1: percentuale mostrata dal player nel DOM.
    if (domPct !== null && domPct >= 99) {
      log(`Video considerato completato dalla percentuale DOM (${domPct}%).`);
      finished = true;
      break;
    }

    // Fonte di verità 2: currentTime a ridosso della fine.
    if (Number.isFinite(status.d) && status.d > 0 && status.t >= status.d - 1.5) {
      finished = true;
      break;
    }

    // Fonte di verità 3: il video ha avanzato significativamente (almeno 95% della
    // durata nota) anche se ended non scatta.
    if (Number.isFinite(status.d) && status.d > 0 && status.t >= status.d * 0.95) {
      log(`Video al ${(status.t / status.d * 100).toFixed(0)}%: considero completato.`);
      finished = true;
      break;
    }

    if (status.t === lastTime) {
      freezeCount++;
      // Recovery leggera: prima di ricaricare la pagina, prova a riavviare il play().
      // Se il player era solo in pausa (caso headless tipico), al prossimo check il
      // currentTime sarà avanzato e freezeCount si resetta. Niente reload -> niente
      // stress sulla sessione.
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
        // Dopo il reload il <video> può metterci qualche secondo a rimontare (lazy)
        // o la pagina può essere rimbalzata su /login: aspettiamo il remount invece
        // di dichiarare subito "video scomparso = finito" al primo check.
        const remounted = await waitForVideo(page, 30000);
        if (remounted) {
          await ensurePlaying(page);
        } else {
          // Dopo reload il <video> non è rimontato: quasi sempre la sessione è
          // caduta e la pagina è rimbalzata su /login. Prima si usciva in modo
          // silenzioso e runCourse insisteva per 3 cicli marcando need_help;
          // ora lanciamo SessionError -> runAutoplay esce con session_unstable
          // (exit 4) e lo scheduler fa cooldown, lasciando riprendere il token.
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

    if (status.ended) finished = true;
  }

  monitor?.update({ videoProgress: 'finished' });
  log('Video finito.');
}

module.exports = { watchVideo };