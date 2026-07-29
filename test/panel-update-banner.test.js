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
  terminalCloseScript, planPanelRestart, renderSprite, pacmanPixels, ghostPixels, mouthAngle,
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

describe('sprite Pac-Man e mostro', () => {
  // Le sagome sono GENERATE dalla geometria, non disegnate a mano: la curva e'
  // davvero un cerchio e l'angolo della bocca, essendo un parametro, si anima.
  it('otto righe di pixel diventano quattro righe di testo', () => {
    assert.equal(renderSprite(pacmanPixels(8, 40), false).length, 4);
    assert.equal(renderSprite(pacmanPixels(16, 40), false).length, 8);
  });

  it('ogni riga conserva la larghezza della griglia', () => {
    for (const r of renderSprite(pacmanPixels(16, 40), false)) assert.equal(r.length, 16);
    for (const r of renderSprite(ghostPixels(16, 'B'), false)) assert.equal(r.length, 16);
  });

  it('la sagoma e tonda: gli angoli restano vuoti', () => {
    const px = pacmanPixels(16, 0);
    assert.equal(px[0][0], '.', 'angolo alto-sinistra vuoto');
    assert.equal(px[15][15], '.', 'angolo basso-destra vuoto');
    assert.equal(px[8][8], 'Y', 'centro pieno');
  });

  it('la bocca si apre a destra e piu gradi = piu pixel tolti', () => {
    const conta = (rows) => rows.join('').split('Y').length - 1;
    const chiusa = conta(pacmanPixels(16, 0));
    const aperta = conta(pacmanPixels(16, 60));
    assert.ok(aperta < chiusa, 'la bocca aperta toglie pixel');
    // Lo spicchio sta a destra: la meta destra perde piu pixel della sinistra.
    const rows = pacmanPixels(16, 60);
    const dx = rows.map((r) => r.slice(8)).join('').split('Y').length - 1;
    const sx = rows.map((r) => r.slice(0, 8)).join('').split('Y').length - 1;
    assert.ok(dx < sx, 'lo spicchio e a destra');
  });

  it('il ciclo della bocca torna al punto di partenza', () => {
    assert.equal(mouthAngle(0), mouthAngle(6));
    assert.ok(new Set([0, 1, 2, 3, 4, 5].map(mouthAngle)).size > 2, 'piu di due posizioni');
  });

  it('il mostro ha occhi bianchi e fondo ondulato', () => {
    const g = ghostPixels(16, 'B');
    assert.ok(g.some((r) => r.includes('W')), 'occhi presenti');
    assert.ok(g[g.length - 1].includes('.'), 'fondo interrotto = onde');
    assert.ok(g[1].includes('B'), 'cupola piena in alto');
  });

  it('il colore del corpo e parametrico (blu quando lavora)', () => {
    assert.ok(ghostPixels(16, 'B').some((r) => r.includes('B')));
    assert.ok(ghostPixels(16, 'P').some((r) => r.includes('P')));
    assert.equal(ghostPixels(16, 'P').some((r) => r.includes('B')), false);
  });

  it('le pupille seguono lo sguardo', () => {
    assert.notDeepEqual(ghostPixels(16, 'B', -1), ghostPixels(16, 'B', 1));
  });

  it('senza colore resta una sagoma leggibile, senza escape ANSI', () => {
    const out = renderSprite(pacmanPixels(16, 40), false).join('');
    assert.ok(/[#-]/.test(out));
    assert.equal(/\u001b/.test(out), false);
  });

  it('su finestra bassa o stretta il banner non compare: prima l informazione', () => {
    const alta = renderFrame(baseModel, { color: true, width: 80, termRows: 40 });
    const bassa = renderFrame(baseModel, { color: true, width: 80, termRows: 20 });
    const stretta = renderFrame(baseModel, { color: true, width: 50, termRows: 40 });
    assert.ok(alta.split('\n').length > bassa.split('\n').length);
    assert.ok(alta.split('\n').length > stretta.split('\n').length);
  });
});

describe('plancia: versione e modalita sviluppo', () => {
  it('mostra versione E data del commit: la versione da sola non dice se si e aggiornato', () => {
    const out = frame({ ...baseModel, version: 'v1.1.0-81', versionDate: '29/07 11:34' });
    assert.match(out, /v1\.1\.0-81 29\/07 11:34/);
  });

  it('senza data mostra almeno la versione', () => {
    assert.match(frame({ ...baseModel, versionDate: null }), /v1\.1\.0-63/);
  });

  it('segnala in alto un aggiornamento gia scaricato', () => {
    const out = frame({ ...baseModel, update: { remoteVersion: 'v1.1.0-90' } });
    assert.match(out, /aggiornamento pronto/);
  });

  it('su un Mac di sviluppo il badge dice sviluppo, non "fermo"', () => {
    // "fermo" in rosso manderebbe a cercare un guasto che non esiste: su una
    // postazione di sviluppo l'automazione NON deve girare.
    const out = frame({ ...baseModel, devMode: true, schedAlive: false });
    assert.match(out, /sviluppo/);
    assert.equal(/fermo/.test(out), false);
  });

  it('senza devMode il badge resta quello normale', () => {
    assert.match(frame({ ...baseModel, devMode: false, schedAlive: false }), /fermo/);
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
