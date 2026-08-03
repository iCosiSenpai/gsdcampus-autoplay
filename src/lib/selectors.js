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
    // Include le lezioni "asincrone": `[href*="/lezione/show/"]` NON matcha
    // `/lezioneAsincrona/show/` (vedi src/lib/lesson-url.js), quindi quelle
    // lezioni erano invisibili al runner e bloccavano il corso.
    lessonLinks: 'a[href*="/lezione/show/"], a[href*="/lezioneAsincrona/show/"]',
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
  // Informativa che precede alcuni corsi. La piattaforma la serve sia su
  // /corso/informativa/<id> sia direttamente su /corso/show/<id>: il
  // riconoscimento deve essere sul FORM, non sull'URL (vedi login-flow.js).
  informativa: {
    courseForm: 'form#informativa_form, form[action*="acceptInformativa"]',
    acceptBoxes: 'input[type="checkbox"].form-check-input.accept',
    submit: 'form#informativa_form button[type="submit"], button[type="submit"].btn.btn-primary',
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
    id: 'course.async_lesson_link',
    page: 'course',
    // NON obbligatorio, e la ragione è una misura, non un'opinione.
    //
    // Su 35 pagine corso reali di cinque account diversi (debug/exploration/<CF>/) un
    // href diretto a /lezioneAsincrona/show/ NON compare mai: l'elenco del corso usa
    // sempre /lezione/show/<id>. La rotta asincrona è quella su cui la piattaforma
    // ATTERRA aprendo quel link (verificato sul corso 17162: l'elenco mostra
    // /lezione/show/14062 e il click porta su /lezioneAsincrona/show/14062).
    //
    // Finché era required:true il probe passava solo perché la fixture qui accanto
    // conteneva quella forma: un contratto verde su una finzione, che è peggio di
    // nessun contratto — non poteva accorgersi di niente e dava l'impressione di
    // vigilare. Resta come probe OPZIONALE: se un giorno la piattaforma cominciasse a
    // emetterla, il report la mostrerebbe presente.
    //
    // Quello che va davvero garantito è course.lesson_link, che è required.
    required: false,
    test: (html) => /href=["'][^"']*\/lezioneAsincrona\/show\/\d+/.test(html),
  },
  {
    // La forma in cui una lezione asincrona compare davvero, quando compare: un
    // rimando con l'indirizzo percent-encoded nella query. Opzionale perché la
    // portano solo alcuni corsi (14 pagine su 35).
    //
    // Attenzione a non usarlo per scoprire il contenuto da guardare: nelle catture
    // punta sempre allo STESSO id per tutti i corsi e tutti gli account — è una
    // lezione condivisa, non la prossima lezione del corso.
    id: 'course.shared_async_nav',
    page: 'course',
    required: false,
    test: (html) => /r_url=lezioneAsincrona%2Fshow%2F\d+/i.test(html),
  },
  {
    id: 'course.quiz_or_open',
    page: 'course',
    required: false,
    test: (html) => /questionario|btn-primary|Apri/i.test(html),
  },
  {
    id: 'informativa.course_form',
    page: 'informativa',
    required: true,
    test: (html) => /id=["']informativa_form["']|action=["'][^"']*acceptInformativa/i.test(html),
  },
  {
    id: 'informativa.accept_boxes',
    page: 'informativa',
    required: true,
    test: (html) => /class=["'][^"']*form-check-input[^"']*accept/i.test(html),
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
  // Le pagine derivano dai PROBES: aggiungere un probe con `page: 'x'` richiede
  // (e verifica) la fixture test/fixtures/selectors/x.snippet.html.
  const pages = [...new Set(PROBES.map((p) => p.page))];
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
