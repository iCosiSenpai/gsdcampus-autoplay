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
  renderFrame, stripAnsi, pacmanBar, pacmanSegments, paintPacman, PAC_FRAMES, terminalCloseScript,
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
    assert.match(out, /chiudila con Q/);
  });

  it('nessun avviso se la finestra gira già sul codice attuale', () => {
    assert.equal(/Si è aggiornato da solo/.test(frame(baseModel, { bootSha: 'bbbbbbb' })), false);
  });
});

describe('plancia: tasti Q e F', () => {
  it('Q è dichiarato come chiusura della SCHEDA, non dell\'app', () => {
    const out = frame(baseModel);
    assert.match(out, /Q chiudi la scheda/);
    assert.match(out, /Q chiude solo questa scheda del Terminale \(non l'app/);
    // Non deve più promettere che chiudere non ferma niente.
    assert.equal(/chiudere la finestra non ferma nulla/.test(out), false);
  });

  it('col guardiano attivo spiega il riavvio automatico', () => {
    assert.match(frame(baseModel), /il guardiano li riavvia entro ~2 minuti/);
  });

  it('senza guardiano avvisa che l\'automazione può fermarsi', () => {
    assert.match(frame({ ...baseModel, keepAlive: false }), /Guardiano non attivo/);
  });

  it('F resta la fermata vera', () => {
    assert.match(frame(baseModel), /F ferma davvero i corsi/);
  });
});

describe('corridoio Pac-Man', () => {
  const posOf = (bar) => [...bar].findIndex((ch) => PAC_FRAMES.includes(ch));

  it('a 0% Pac-Man è all\'inizio, a 100% in fondo', () => {
    assert.equal(pacmanBar(0, 12, 0).length, 12);
    assert.equal(posOf(pacmanBar(0, 12, 0)), 0);
    assert.equal(posOf(pacmanBar(100, 12, 0)), 11);
  });

  it('la bocca fa un ciclo di 4 frame (spalancata, media, chiusa, media)', () => {
    assert.equal(PAC_FRAMES.length, 4);
    assert.equal(PAC_FRAMES[0], '◖');
    assert.equal(PAC_FRAMES[1], 'ᗧ');
    assert.equal(PAC_FRAMES[2], '●');
    assert.equal(PAC_FRAMES[3], 'ᗧ');
    const frames = [0, 1, 2, 3].map((f) => pacmanBar(50, 16, f));
    assert.equal(new Set(frames).size, 3); // 3 forme distinte, la media si ripete
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
