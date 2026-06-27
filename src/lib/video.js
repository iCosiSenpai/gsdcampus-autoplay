function formatTime(t) {
  if (!isFinite(t)) return '--:--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function watchVideo(page, log, monitor) {
  log('Video in corso...');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      v.play();
    }
  });

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
      log(`Video progress stalled. Freeze count: ${freezeCount}/3`);
      if (freezeCount >= 3) {
        reloadCount++;
        if (reloadCount > MAX_RELOADS) {
          log('MAX_RELOADS reached. Giving up on this video and moving to next content.');
          break;
        }
        log(`Video frozen detected! Recovery action: reloading page (Attempt ${reloadCount}/${MAX_RELOADS})...`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        await page.evaluate(() => {
          const v = document.querySelector('video');
          if (v) { v.muted = true; v.play(); }
        }).catch(() => {});
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
