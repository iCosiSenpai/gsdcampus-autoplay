'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isActivePhase,
  reconcileStatusObject,
} = require('../src/lib/status-reconcile');

describe('isActivePhase', () => {
  it('video/quiz sono attive', () => {
    assert.equal(isActivePhase('video'), true);
    assert.equal(isActivePhase('quiz'), true);
    assert.equal(isActivePhase('starting'), true);
  });
  it('need_help/done/stopped sono terminali', () => {
    assert.equal(isActivePhase('need_help'), false);
    assert.equal(isActivePhase('done'), false);
    assert.equal(isActivePhase('stopped'), false);
    assert.equal(isActivePhase('off_hours'), false);
  });
});

describe('reconcileStatusObject', () => {
  it('processo vivo → no-op', () => {
    const s = { running: true, phase: 'video', courseUrl: 'https://x/corso/show/1' };
    const r = reconcileStatusObject(s, { processAlive: true });
    assert.equal(r.changed, false);
    assert.equal(r.status.running, true);
    assert.equal(r.status.phase, 'video');
  });

  it('running orfano + phase attiva → stopped', () => {
    const s = { running: true, phase: 'quiz', courseUrl: 'https://x/corso/show/99' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'stopped');
    assert.ok(r.status.note);
    assert.equal(r.status.courseUrl, 'https://x/corso/show/99'); // conservato
  });

  it('need_help non viene rimpiazzato', () => {
    const s = { running: true, phase: 'need_help' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'need_help');
  });

  it('running true ma phase già stopped → solo running', () => {
    const s = { running: true, phase: 'stopped' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'stopped');
  });

  it('running false + phase attiva orfana → phase stopped', () => {
    const s = { running: false, phase: 'video' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.phase, 'stopped');
    assert.equal(r.status.running, false);
  });

  it('forceStopped ignora processAlive true', () => {
    const s = { running: true, phase: 'video' };
    const r = reconcileStatusObject(s, { processAlive: true, forceStopped: true });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'stopped');
  });

  it('idle coerente → no-op', () => {
    const s = { running: false, phase: 'idle' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, false);
  });

  it('scheduler off_hours orfano → schedulerRunning false e stopped', () => {
    const out = reconcileStatusObject({ phase: 'off_hours', running: false, schedulerRunning: true }, { processAlive: false });
    assert.equal(out.changed, true);
    assert.equal(out.status.schedulerRunning, false);
    assert.equal(out.status.phase, 'stopped');
  });
});


describe('la app nativa e automazione quanto lo scheduler', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {
    APP_PROCESS_RE,
    readAppPid,
    isAnyAutomationAlive,
  } = require('../src/lib/status-reconcile');

  it('il pattern riconosce il processo della app e non chi ne parla', () => {
    // La riga vera, come la scrive ps.
    assert.equal(
      APP_PROCESS_RE.test('/Applications/Autoplay San.app/Contents/MacOS/Autoplay San'),
      true
    );
    // E anche la copia di sviluppo, che sta in una cartella di build.
    assert.equal(
      APP_PROCESS_RE.test('/Users/x/dev/autoplay-san/.build/xcode-dbg/Build/Products/Debug/Autoplay San.app/Contents/MacOS/Autoplay San'),
      true
    );
    // Ma non un comando che NOMINA la app senza essere la app: ancorarsi al solo nome
    // avrebbe fatto passare per automazione viva un tail sul diario.
    assert.equal(APP_PROCESS_RE.test('tail -f /Users/x/gsdcampus-autoplay/logs/autoplay.log'), false);
    assert.equal(APP_PROCESS_RE.test('grep -r "Autoplay San" .'), false);
  });

  it('legge il pid che la app dichiara, e ignora quello che non e un numero', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'san-status-'));
    fs.mkdirSync(path.join(root, 'logs'));
    const write = (obj) => fs.writeFileSync(
      path.join(root, 'logs', 'status.json'), JSON.stringify(obj)
    );

    write({ pid: 4242, running: true });
    assert.equal(readAppPid(root), 4242);

    // Un pid assente, zero o non numerico non e un pid: meglio nessuna risposta che una
    // finta, perche' su una risposta finta si va a interrogare un processo qualunque.
    write({ running: true });
    assert.equal(readAppPid(root), null);
    write({ pid: 0, running: true });
    assert.equal(readAppPid(root), null);
    write({ pid: 'no', running: true });
    assert.equal(readAppPid(root), null);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('senza processi e senza pid dichiarato non inventa automazione viva', () => {
    // Il verso opposto conta quanto l'altro: se questa funzione dicesse «viva» per
    // prudenza, uno status vecchio con phase "video" non verrebbe mai riconciliato e
    // resterebbe a raccontare per sempre un run finito giorni prima.
    //
    // Nota su cosa NON si prova qui: il ripiego finale scansiona tutti i processi del Mac,
    // quindi non e' legato alla cartella. Un primo tentativo aggiungeva la app a quella
    // scansione, e questo test l'ha bocciato — con la app davvero in esecuzione rispondeva
    // «viva» per QUALUNQUE cartella, compresa una temporanea vuota. Il riconoscimento della
    // app passa quindi dal pid che lei dichiara in quella cartella, che e' un fatto locale.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'san-status-'));
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'status.json'), JSON.stringify({ pid: 999999 }));
    assert.equal(isAnyAutomationAlive(root), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('uno stato appena scritto non si corregge', () => {
  const {
    reconcileStatusObject: reconcile,
    FRESH_WINDOW_MS,
  } = require('../src/lib/status-reconcile');

  const now = new Date('2026-08-03T20:00:00.000Z');
  const at = (msAgo) => new Date(now.getTime() - msAgo).toISOString();

  it('chi scrive adesso e vivo adesso, qualunque cosa dicano i processi', () => {
    // Il caso misurato: la app nativa guardava una lezione, nessun processo Node in giro, e
    // status.sh riscriveva phase "stopped" mentre il video avanzava. Quel file e' la fonte
    // da cui si capisce se l'automazione lavora: dire «ferma» invita ad avviarne una
    // seconda, cioe' a spegnere i salvataggi di quella in corso.
    const out = reconcile(
      { running: true, phase: 'video', lastUpdate: at(5 * 1000) },
      { processAlive: false, now }
    );
    assert.equal(out.changed, false);
    assert.equal(out.reason, 'fresh_writer');
    assert.equal(out.status.phase, 'video');
    assert.equal(out.status.running, true);
  });

  it('uno stato vecchio senza nessuno che lo scriva viene corretto', () => {
    // L'altro verso, che e' la ragione per cui la riconciliazione esiste: un run finito
    // giorni prima non deve raccontare per sempre di essere in corso.
    const out = reconcile(
      { running: true, phase: 'video', lastUpdate: at(FRESH_WINDOW_MS + 1000) },
      { processAlive: false, now }
    );
    assert.equal(out.changed, true);
    assert.equal(out.status.phase, 'stopped');
    assert.equal(out.status.running, false);
  });

  it('senza data non si presume freschezza', () => {
    // Un file senza lastUpdate non porta nessuna prova di un vivo: si riconcilia.
    const out = reconcile({ running: true, phase: 'video' }, { processAlive: false, now });
    assert.equal(out.changed, true);
    assert.equal(out.status.phase, 'stopped');
  });

  it('una data nel futuro non vale come freschezza', () => {
    // Un orologio spostato o una scrittura da un altro fuso non devono poter congelare la
    // riconciliazione per sempre.
    const out = reconcile(
      { running: true, phase: 'video', lastUpdate: at(-60 * 60 * 1000) },
      { processAlive: false, now }
    );
    assert.equal(out.changed, true);
    assert.equal(out.status.phase, 'stopped');
  });

  it('dopo uno stop esplicito la freschezza non protegge niente', () => {
    // forceStopped e' il caso opposto: chi chiama sa di aver appena fermato tutto, e il file
    // fresco e' proprio quello scritto un istante prima di morire.
    const out = reconcile(
      { running: true, phase: 'video', lastUpdate: at(1000) },
      { forceStopped: true, now }
    );
    assert.equal(out.changed, true);
    assert.equal(out.status.running, false);
    assert.equal(out.status.phase, 'stopped');
  });
});
