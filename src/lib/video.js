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

  while (!finished) {
    await page.waitForTimeout(30000);
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
