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

    const status = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { ended: v.ended, t: v.currentTime, d: v.duration } : null;
    }).catch(() => null);

    if (!status) {
      log('Video element scomparso, esco.');
      break;
    }

    monitor?.update({ phase: 'video', videoProgress: `${formatTime(status.t)} / ${formatTime(status.d)}` });
    log(`Video: ${formatTime(status.t)} / ${formatTime(status.d)}`);

    // Se la durata è nota, considera finito anche quando si arriva a ridosso della fine
    // (alcuni player non impostano subito v.ended).
    if (Number.isFinite(status.d) && status.d > 0 && status.t >= status.d - 1.5) {
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
