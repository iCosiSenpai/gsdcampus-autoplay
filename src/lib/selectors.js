// @ts-check
/**
 * selectors.js — catalogo selettori/marker DOM critici della piattaforma GSD.
 *
 * Single source per documentazione e probe offline (fixture HTML).
 * I call-site di autoplay/quiz possono migrare gradualmente; qui non si cambia
 * il runtime se non per il probe.
 *
 * Probe HTML: solo pattern grezzi (regex/indexOf), niente Playwright / linkedom.
 */

/** Selettori Playwright / CSS usati nel codice (riferimento). */
const SELECTORS = {
  dashboard: {
    pathHint: '/corso/listAllByUser',
    courseLinks: 'a[href*="/corso/show/"]',
  },
  course: {
    lessonLinks: 'a[href*="/lezione/show/"]',
    quizLinks: 'a[href*="/questionario/"]',
    usageForm: '#conferma_vincolo_orario_form',
  },
  quiz: {
    form: 'form#aggiungi_risposta',
    option: '.opzione-risposta',
  },
  login: {
    password: 'input[type="password"]',
  },
};

/**
 * Probe list: marker verificabili su HTML grezzo.
 * `test` riceve html string → boolean.
 * `page` allinea al file fixture (dashboard|course|quiz|usage).
 */
const PROBES = [
  {
    id: 'dashboard.course_link',
    page: 'dashboard',
    required: true,
    test: (html) => /href=["'][^"']*\/corso\/show\/\d+/.test(html),
  },
  {
    id: 'dashboard.path_hint',
    page: 'dashboard',
    required: false,
    test: (html) => /listAllByUser|i miei corsi|i tuoi corsi/i.test(html),
  },
  {
    id: 'course.lesson_link',
    page: 'course',
    required: true,
    test: (html) => /href=["'][^"']*\/lezione\/show\/\d+/.test(html),
  },
  {
    id: 'course.quiz_or_open',
    page: 'course',
    required: false,
    test: (html) => /questionario|btn-primary|Apri/i.test(html),
  },
  {
    id: 'quiz.form',
    page: 'quiz',
    required: true,
    test: (html) => /id=["']aggiungi_risposta["']|form#aggiungi_risposta|<form[^>]*aggiungi_risposta/i.test(html),
  },
  {
    id: 'quiz.option',
    page: 'quiz',
    required: true,
    test: (html) => /opzione-risposta/.test(html),
  },
  {
    id: 'quiz.avanti',
    page: 'quiz',
    required: true,
    test: (html) => />\s*Avanti\s*</i.test(html) || /Avanti/.test(html),
  },
  {
    id: 'usage.form_or_confirm',
    page: 'usage',
    required: true,
    test: (html) =>
      /conferma_vincolo_orario/i.test(html) || /Confermo e proseguo/i.test(html),
  },
];

/**
 * Esegue i probe su un pezzo di HTML (opz. filtrati per page).
 * @returns {{ ok: boolean, hits: object[], missing: string[] }}
 */
function probeHtml(html, pageKind = null) {
  const list = pageKind
    ? PROBES.filter((p) => p.page === pageKind)
    : PROBES;
  const hits = [];
  const missing = [];
  for (const p of list) {
    const found = !!(html && p.test(html));
    hits.push({ id: p.id, page: p.page, required: !!p.required, found });
    if (p.required && !found) missing.push(p.id);
  }
  return { ok: missing.length === 0, hits, missing };
}

/**
 * Probe su directory fixture: file <page>.snippet.html
 * @returns {{ ok: boolean, pages: object[], missing: string[] }}
 */
function probeFixtures(dir) {
  const fs = require('fs');
  const path = require('path');
  const pages = ['dashboard', 'course', 'quiz', 'usage'];
  const report = { ok: true, pages: [], missing: [] };
  for (const page of pages) {
    const file = path.join(dir, `${page}.snippet.html`);
    let html = '';
    try { html = fs.readFileSync(file, 'utf8'); } catch (_) {
      report.ok = false;
      report.missing.push(`fixture:${page}`);
      report.pages.push({ page, ok: false, missing: [`fixture missing: ${file}`], hits: [] });
      continue;
    }
    const r = probeHtml(html, page);
    report.pages.push({ page, ...r });
    if (!r.ok) {
      report.ok = false;
      report.missing.push(...r.missing);
    }
  }
  return report;
}

module.exports = {
  SELECTORS,
  PROBES,
  probeHtml,
  probeFixtures,
};
