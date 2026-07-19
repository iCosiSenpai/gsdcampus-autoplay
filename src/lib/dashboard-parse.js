/**
 * dashboard-parse.js — estrazione corsi e % completamento dalla dashboard GSD.
 *
 * Bug storico: census leggeva (aria-label || style) e matchava % solo sulla
 * stringa risultante. aria-label è "Ditta: …" (sempre valorizzato, senza %)
 * → lo style "width: 30.51%;" non veniva mai consultato → pct sempre null.
 *
 * Priorità pct (per card):
 *  1. progress-bar style width: N%
 *  2. aria-label se contiene una %
 *  3. testo card (fallback)
 */

/** @param {number} n */
function clampPct(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Estrae una percentuale da style/aria/testo.
 * @param {{ style?: string|null, aria?: string|null, text?: string|null }} src
 * @returns {number|null}
 */
function parsePctCandidates(src = {}) {
  const style = src.style != null ? String(src.style) : '';
  const aria = src.aria != null ? String(src.aria) : '';
  const text = src.text != null ? String(src.text) : '';

  // 1) style width: 30.51%  (fonte di verità sulle card live)
  let m = style.match(/width\s*:\s*([\d]+(?:[.,]\d+)?)\s*%/i);
  if (m) return clampPct(parseFloat(m[1].replace(',', '.')));

  // 2) qualsiasi % nello style
  m = style.match(/([\d]+(?:[.,]\d+)?)\s*%/);
  if (m) return clampPct(parseFloat(m[1].replace(',', '.')));

  // 3) aria solo se contiene %
  m = aria.match(/([\d]+(?:[.,]\d+)?)\s*%/);
  if (m) return clampPct(parseFloat(m[1].replace(',', '.')));

  // 4) testo card (evita di usare il body intero della pagina)
  m = text.match(/([\d]+(?:[.,]\d+)?)\s*%/);
  if (m) return clampPct(parseFloat(m[1].replace(',', '.')));

  return null;
}

/**
 * Arricchisce righe grezze dalla DOM (url, title, style, aria, text) con pct.
 * @param {Array<{ url: string, title?: string, style?: string, aria?: string, text?: string }>} raw
 */
function enrichCourseRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const url = r && r.url ? String(r.url) : '';
    const idM = url.match(/\/corso\/show\/(\d+)/);
    return {
      url,
      courseId: idM ? idM[1] : null,
      title: r.title != null ? String(r.title).trim() : '',
      pct: parsePctCandidates({
        style: r.style,
        aria: r.aria,
        text: r.text,
      }),
    };
  }).filter((c) => c.url && c.courseId);
}

/**
 * Estrae card da HTML statico (test / fixture), senza jsdom.
 * @param {string} html
 * @returns {Array<{ url: string, title: string, style: string, aria: string, text: string }>}
 */
function extractCardsFromHtml(html) {
  const s = String(html || '');
  // Solo .card root (class="card …"), NON card-body / card-title / card-footer.
  const parts = s.split(/class="card(?![-\w])[^"]*"/i).slice(1);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const hrefM = part.match(/href="(https?:\/\/[^"]*\/corso\/show\/\d+[^"]*)"/i)
      || part.match(/href="(\/corso\/show\/\d+[^"]*)"/i);
    if (!hrefM) continue;
    let url = hrefM[1];
    if (url.startsWith('/')) url = 'https://tecsial.gsdcampus.it' + url;
    const idM = url.match(/\/corso\/show\/(\d+)/);
    const id = idM ? idM[1] : url;
    if (seen.has(id)) continue;
    seen.add(id);
    const titleM = part.match(/card-title[^>]*>([\s\S]*?)<\//i);
    const title = titleM
      ? titleM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    // style può essere su progress-bar con altri attr in mezzo; cerca width: N% nella card
    let style = '';
    let aria = '';
    const barOpen = part.match(/progress-bar\b[^>]*>/i);
    if (barOpen) {
      const tag = barOpen[0];
      const sm = tag.match(/style="([^"]*)"/i);
      const am = tag.match(/aria-label="([^"]*)"/i);
      if (sm) style = sm[1];
      if (am) aria = am[1];
    }
    if (!style) {
      const wm = part.match(/style="([^"]*width\s*:\s*[\d.,]+\s*%[^"]*)"/i);
      if (wm) style = wm[1];
    }
    const text = part.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
    out.push({ url, title, style, aria, text });
  }
  return out;
}

/**
 * Da HTML dashboard → corsi con pct.
 * @param {string} html
 */
function parseCoursesFromDashboardHtml(html) {
  return enrichCourseRows(extractCardsFromHtml(html));
}

/**
 * Funzione da passare a page.evaluate: raccoglie dati grezzi dalle .card.
 * (non può importare moduli Node: solo DOM API)
 */
function collectCoursesFromDom() {
  const out = [];
  document.querySelectorAll('.card').forEach((card) => {
    const link = card.querySelector('a[href*="/corso/show/"]');
    if (!link) return;
    const titleEl = card.querySelector('.card-title');
    const title = (titleEl ? titleEl.innerText : '').trim();
    const bar = card.querySelector('.progress-bar');
    const style = bar ? (bar.getAttribute('style') || '') : '';
    const aria = bar ? (bar.getAttribute('aria-label') || '') : '';
    const text = (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    out.push({ url: link.href, title, style, aria, text });
  });
  return out;
}

module.exports = {
  parsePctCandidates,
  enrichCourseRows,
  extractCardsFromHtml,
  parseCoursesFromDashboardHtml,
  collectCoursesFromDom,
  clampPct,
};
