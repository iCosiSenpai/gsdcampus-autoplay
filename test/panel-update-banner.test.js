'use strict';
/**
 * Plancia: versione release nell'header, barra Pac-Man, avviso "si è aggiornato
 * da solo" (finestra rimasta aperta) e semantica dei tasti Q/F.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// I glifi (Pac-Man, fantasmino) sono scelti al require in base al locale: in CI
// LANG può non essere UTF-8. Forziamolo qui così le asserzioni sono stabili.
process.env.LANG = 'en_US.UTF-8';

const {
  renderFrame, stripAnsi, pacmanBar, pacmanSegments, paintPacman, PAC_FRAMES,
  terminalCloseScript, planPanelRestart,
} = require('../scripts/lib/panel-cli');
const { readHeadSha } = require('../src/lib/update-state');

const baseModel = {
  now: Date.UTC(2026, 6, 28, 12, 0, 0),
  member: 'MARIO ROSSI',
  version: 'v1.1.0-63',
  keepAlive: true,
  status: { phase: 'off_hours' },
  summary: null,
  census: null,
  todo: {},
  update: null,
  usage: null,
  autoUpdate: { text: "controllato 4m fa · già all'ultima versione (aaaaaaa)", level: 'ok', stale: false, ageMs: 240000 },
  headSha: 'bbbbbbb',
  claudeState: null,
  claudeWorking: false,
  schedAlive: true,
  workNow: false,
  nextStart: null,
  scheduleDesc: 'lun, mar → 09:00-13:00',
  courseTitle: null,
  videoPct: null,
  openQuiz: 0,
  events: [],
  stale: false,
};

const frame = (model, opts = {}) => stripAnsi(renderFrame(model, { color: false, width: 72, ...opts }));

describe('plancia: header e versione', () => {
  it('mostra il marchio e la versione accanto al nome', () => {
    assert.match(frame(baseModel), /GSD CAMPUS · MARIO ROSSI · v1\.1\.0-63/);
  });

  it('senza versione non stampa separatori vuoti', () => {
    const out = frame({ ...baseModel, version: null });
    assert.match(out, /GSD CAMPUS · MARIO ROSSI\s{2,}/);
  });
});

describe('plancia: riga auto-aggiornamento', () => {
  it('mostra "controllato N fa" nel riquadro', () => {
    assert.match(frame(baseModel), /Aggiorn\..*controllato 4m fa/);
  });

  it('avvisa quando il codice è cambiato dopo l\'apertura della finestra', () => {
    const out = frame(baseModel, { bootSha: 'aaaaaaa' });
    assert.match(out, /Si è aggiornato da solo \(aaaaaaa/);
  });

  it('annuncia il riavvio automatico col conto alla rovescia', () => {
    const out = frame(baseModel, { bootSha: 'aaaaaaa', restartIn: 4 });
    assert.match(out, /Riapro questa schermata con la versione nuova tra 4s/);
    assert.match(out, /i corsi non si fermano/);
  });

  it('se c\'è un quiz in corso dice che aspetta', () => {
    const out = frame(baseModel, { bootSha: 'aaaaaaa', restartHeld: 'Claude sta risolvendo un quiz' });
    assert.match(out, /Claude sta risolvendo un quiz — riapro la schermata appena ha finito/);
  });

  it('nessun avviso se la finestra gira già sul codice attuale', () => {
    assert.equal(/Si è aggiornato da solo/.test(frame(baseModel, { bootSha: 'bbbbbbb' })), false);
  });
});

describe('plancia: menu a frecce', () => {
  // Il menu ha sostituito i tasti a lettera. L'intenzione da difendere resta la
  // stessa: "Ferma tutto" deve dichiararsi come stop VERO (corsi + scheduler +
  // guardiano), non come semplice chiusura di finestra, e deve esistere
  // un'uscita che lascia lavorare il Mac.
  const MENU = [
    { id: 'log', label: 'Guarda dal vivo', help: 'Mostra il log mentre scorre. Sola lettura: guardare non ferma niente.' },
    { id: 'registro', label: 'Registro attività', help: 'Cronologia con data e ora, divisa per esecuzione.' },
    { id: 'refresh', label: 'Aggiorna ora', help: 'Rilegge subito lo stato senza aspettare il prossimo giro.' },
    { id: 'stop', label: 'Ferma tutto', help: 'Ferma corsi, scheduler e guardiano, poi chiude la scheda. Chiede conferma.' },
    { id: 'exit', label: 'Esci', help: 'Chiude solo questa scheda: i corsi continuano a lavorare.' },
  ];
  const withMenu = (model, selected = 0) => frame(model, { menu: MENU, selected });

  it('elenca tutte le voci del menu', () => {
    const out = withMenu(baseModel);
    for (const item of MENU) assert.match(out, new RegExp(item.label.replace('à', '.')));
  });

  it('non chiede piu di premere lettere', () => {
    const out = withMenu(baseModel);
    assert.equal(/Q ferma tutto e chiudi/.test(out), false);
    assert.equal(/L guarda dal vivo/.test(out), false);
    assert.match(out, /← → scegli/);
    assert.match(out, /Invio conferma/);
  });

  it('su "Ferma tutto" dichiara che ferma davvero, non solo la finestra', () => {
    const out = withMenu(baseModel, 3);
    assert.match(out, /Ferma corsi, scheduler e guardiano/);
    assert.match(out, /Chiede conferma/);
    assert.equal(/chiudere la finestra non ferma nulla/.test(out), false);
  });

  it('su "Esci" chiarisce che i corsi continuano', () => {
    assert.match(withMenu(baseModel, 4), /i corsi continuano a lavorare/);
  });

  it('mostra l aiuto solo della voce selezionata', () => {
    const out = withMenu(baseModel, 0);
    assert.match(out, /guardare non ferma niente/);
    assert.equal(/Ferma corsi, scheduler e guardiano/.test(out), false);
  });

  it('col guardiano attivo chiarisce che dopo lo stop non si riparte da soli', () => {
    assert.match(withMenu(baseModel), /l'automazione resta ferma finché non la riavvii tu/);
  });

  it('senza guardiano avvisa che l\'automazione può fermarsi', () => {
    assert.match(withMenu({ ...baseModel, keepAlive: false }), /Guardiano non attivo/);
  });

  it('senza menu (--once) elenca comunque le azioni', () => {
    const out = frame(baseModel);
    assert.match(out, /Guarda dal vivo/);
    assert.match(out, /Ferma tutto/);
    assert.match(out, /scegli con ← → e conferma con Invio/);
  });
});

describe('corridoio Pac-Man', () => {
  const posOf = (bar) => [...bar].findIndex((ch) => PAC_FRAMES.includes(ch));

  it('a 0% Pac-Man è all\'inizio, a 100% in fondo', () => {
    assert.equal(pacmanBar(0, 12, 0).length, 12);
    assert.equal(posOf(pacmanBar(0, 12, 0)), 0);
    assert.equal(posOf(pacmanBar(100, 12, 0)), 11);
  });

  it('la bocca alterna aperto e chiuso, senza cambiare peso visivo', () => {
    // Due sole forme, entrambe della stessa famiglia di glifi. Il vecchio ciclo
    // includeva `◖` (mezzo disco pieno): larghezza e peso diversi da `ᗧ` nella
    // maggior parte dei font monospace, quindi Pac-Man sobbalzava.
    assert.equal(new Set(PAC_FRAMES).size, 2, 'due forme distinte');
    assert.ok(PAC_FRAMES.includes('ᗧ'), 'bocca aperta');
    assert.ok(PAC_FRAMES.includes('●'), 'bocca chiusa');
    assert.equal(PAC_FRAMES.includes('◖'), false, 'niente mezzo disco');
    const frames = [0, 1, 2, 3].map((f) => pacmanBar(50, 16, f));
    assert.equal(new Set(frames).size, 2);
    // Il ciclo torna al punto di partenza: nessuno scatto al giro successivo.
    assert.equal(pacmanBar(50, 16, 0), pacmanBar(50, 16, PAC_FRAMES.length));
  });

  it('i fantasmi si spaventano quando Pac-Man e addosso', () => {
    const lontano = pacmanSegments(20, 40, 0, { ghosts: 3 });
    assert.ok(lontano.some((c) => c.kind === 'ghost'));
    assert.equal(lontano.some((c) => c.kind === 'ghostScared'), false);

    const vicino = pacmanSegments(98, 40, 0, { ghosts: 3 });
    assert.ok(vicino.some((c) => c.kind === 'ghostScared'), 'diventano blu a fine corsa');
  });

  it('quanti fantasmi chiedo, tanti compaiono (max 4)', () => {
    assert.equal((pacmanBar(20, 24, 0, { ghosts: 3 }).match(/ᗣ/g) || []).length, 3);
    assert.equal((pacmanBar(20, 24, 0, { ghosts: 9 }).match(/ᗣ/g) || []).length, 4);
    assert.equal(/ᗣ/.test(pacmanBar(20, 24, 0)), false);
  });

  it('senza fantasmi in fondo c\'è la pastiglia grande', () => {
    assert.match(pacmanBar(20, 24, 0), /◉$/);
  });

  it('compatibilità: ghost:true = un fantasma', () => {
    assert.match(pacmanBar(30, 16, 0, { ghost: true }), /ᗣ$/);
  });

  it('percentuali fuori scala non rompono la larghezza', () => {
    assert.equal(pacmanBar(-40, 14, 0).length, 14);
    assert.equal(pacmanBar(999, 14, 0).length, 14);
  });

  it('paintPacman colora Pac-Man di giallo e i fantasmi coi colori originali', () => {
    const painted = paintPacman(pacmanSegments(40, 20, 1, { ghosts: 2 }), true);
    assert.match(painted, /\x1b\[1;38;5;226mᗧ/);      // giallo Pac-Man
    assert.match(painted, /\x1b\[38;5;213m/);          // Pinky (rosa)
    assert.match(painted, /\x1b\[38;5;203m/);          // Blinky (rosso)
    // Senza colori resta testo puro (README, terminali senza colore).
    assert.equal(paintPacman(pacmanSegments(40, 20, 1), false), pacmanBar(40, 20, 1));
  });
});

describe('terminalCloseScript', () => {
  it('Terminal.app: chiude la scheda selezionata, non l\'applicazione', () => {
    const s = terminalCloseScript('Apple_Terminal');
    assert.match(s, /selected tab of front window/);
    assert.equal(/quit/.test(s), false);
  });

  it('iTerm2: chiude la sessione corrente', () => {
    const s = terminalCloseScript('iTerm.app');
    assert.match(s, /current session to close/);
    assert.equal(/quit/.test(s), false);
  });

  it('terminale non riconosciuto: nessuno script (no-op)', () => {
    assert.equal(terminalCloseScript('vscode'), null);
    assert.equal(terminalCloseScript(''), null);
  });
});

describe('readHeadSha', () => {
  it('legge il ref loose del branch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-head-'));
    fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'main'), '0123456789abcdef0123456789abcdef01234567\n');
    assert.equal(readHeadSha(root), '0123456');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('ripiega su packed-refs quando il ref non è su file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-head-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(root, '.git', 'packed-refs'), '# pack-refs with: peeled\nfedcba9876543210fedcba9876543210fedcba98 refs/heads/main\n');
    assert.equal(readHeadSha(root), 'fedcba9');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('senza .git ritorna null (nessuna eccezione)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-head-'));
    assert.equal(readHeadSha(root), null);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('planPanelRestart', () => {
  const now = 1_000_000;
  const base = { bootSha: 'aaaaaaa', headSha: 'bbbbbbb', now };

  it('codice invariato: nessun riavvio', () => {
    assert.deepEqual(planPanelRestart({ bootSha: 'aaa', headSha: 'aaa' }), { action: 'none' });
  });

  it('appena rilevato annuncia il preavviso', () => {
    assert.deepEqual(planPanelRestart(base), { action: 'wait', seconds: 6 });
  });

  it('scaduto il preavviso riavvia', () => {
    assert.deepEqual(planPanelRestart({ ...base, detectedAt: now - 7000 }), { action: 'restart' });
  });

  it('aspetta se si sta leggendo il log o confermando una fermata', () => {
    assert.equal(planPanelRestart({ ...base, detectedAt: now - 7000, view: 'log' }).action, 'wait');
    assert.equal(planPanelRestart({ ...base, detectedAt: now - 7000, confirmStop: true }).action, 'wait');
  });

  it('aspetta durante un quiz, ma non per sempre', () => {
    const held = planPanelRestart({ ...base, detectedAt: now - 7000, busy: true, busyLabel: 'quiz in corso' });
    assert.deepEqual(held, { action: 'wait', reason: 'quiz in corso' });
    assert.equal(planPanelRestart({ ...base, detectedAt: now - 6 * 60 * 1000, busy: true }).action, 'restart');
  });
});
