/**
 * login-flow.js — handler di pagine intermedie post-login / pre-corso.
 *
 * Estratto da autoplay.js (solo confini di modulo): nessuna logica nuova.
 * Ogni funzione riceve (page, log) e ritorna true se ha agito, false altrimenti.
 */

const { redactUrl } = require('./logger');

// Gestisce eventuali pagine intermedie post-autologin, come:
// - scelta utente/ruolo;
// - accettazione termini/privacy;
// - pop-up "Continua".
async function handlePostLoginInterstitial(page, log) {
  try {
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    // redactUrl: subito dopo l'autologin l'URL può ancora contenere il token —
    // non deve finire in chiaro in logs/autoplay.log.
    const currentUrl = redactUrl(page.url());

    // Pop-up o pagina con bottone "Continua", "Accedi", "Conferma", "Prosegui".
    // I selettori con testo esplicito hanno la priorità; il submit generico è
    // ultimo resort e viene blindato contro submit di logout/uscita (per non
    // cliccare il bottone sbagliato su pagine con più form).
    const proceedSelectors = [
      'button:has-text("Continua")',
      'button:has-text("Prosegui")',
      'button:has-text("Conferma")',
      'button:has-text("Accedi")',
      'a:has-text("Continua")',
      'a:has-text("Prosegui")',
      'input[type="submit"]'
    ];
    for (const sel of proceedSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        // Blindatura del submit generico: salta bottoni che sembrano logout/uscita.
        if (sel === 'input[type="submit"]') {
          const val = (await btn.getAttribute('value').catch(() => '')) || '';
          if (/esci|logout|chiudi|annulla|esc/i.test(String(val))) {
            log(`Pagina intermedia (${currentUrl}): submit '${val}' sembra logout, lo salto.`);
            continue;
          }
          log(`Pagina intermedia rilevata (${currentUrl}). Clicco submit '${val}'...`);
        } else {
          log(`Pagina intermedia rilevata (${currentUrl}). Clicco '${sel}'...`);
        }
        await btn.click().catch(() => {});
        await page.waitForTimeout(3000);
        return true;
      }
    }

    // Checkbox di accettazione privacy/termini
    if (/accetto|termini|privacy|condizioni/i.test(bodyText)) {
      const checkboxes = await page.locator('input[type="checkbox"]').all();
      let checked = 0;
      for (const cb of checkboxes) {
        try {
          await cb.check();
          checked++;
        } catch (_) {}
      }
      if (checked > 0) {
        log(`Spuntate ${checked} checkbox di accettazione.`);
        const submitBtn = page.locator('button[type="submit"], button.btn-primary, input[type="submit"]').first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click().catch(() => {});
          await page.waitForTimeout(3000);
        }
        return true;
      }
    }

    return false;
  } catch (e) {
    log(`Errore gestione pagina intermedia: ${e.message}`);
    return false;
  }
}

// Gestisce la pagina di informativa/accettazione che precede alcuni corsi.
// Spunta le checkbox della privacy/scheda tecnica e clicca "Prosegui".
async function handleCourseInformativa(page, log) {
  const url = page.url();
  if (!url.includes('/corso/informativa/')) return false;
  log(`Pagina informativa rilevata (${redactUrl(url)}). Cerco checkbox da accettare...`);
  try {
    const checkboxes = await page.locator('input[type="checkbox"].form-check-input.accept').all();
    if (checkboxes.length === 0) {
      log('Nessuna checkbox di accettazione trovata.');
      return false;
    }
    for (const cb of checkboxes) {
      await cb.check().catch(() => {});
    }
    log(`Spuntate ${checkboxes.length} checkbox. Attendo abilitazione bottone...`);
    await page.waitForTimeout(1000);
    const submitBtn = page.locator('button[type="submit"].btn.btn-primary');
    const exists = await submitBtn.count().catch(() => 0) > 0;
    if (!exists) {
      log('Bottone Prosegui non trovato.');
      return false;
    }
    const isDisabled = await submitBtn.isDisabled().catch(() => true);
    if (isDisabled) {
      log('Bottone ancora disabilitato; forzo enabled via JS.');
      await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"].btn.btn-primary');
        if (btn) btn.disabled = false;
      });
    }
    await submitBtn.click().catch(e => log(`Errore click submit: ${e.message}`));
    await page.waitForTimeout(4000);
    log(`Dopo submit: URL = ${redactUrl(page.url())}`);
    return true;
  } catch (e) {
    log(`Errore gestione informativa: ${e.message}`);
    return false;
  }
}

// Gestisce la pagina di accettazione informativa che appare DOPO il login
// (URL /informativa/acceptPrivacyPolicy, e sibling come /informativa/accept* per
// la scheda tecnica). A differenza di handleCourseInformativa (che è sulla
// pagina /corso/informativa/ con checkbox), qui NON ci sono checkbox: basta
// cliccare il bottone "Confermo" del form. Il form ha un hidden csrf_token, e il
// click sul submit sottomette nativamente (POST con csrf), niente POST manuale.
// Idempotente: torna false se non siamo sulla pagina (es. privacy già accettata
// in un run precedente).
async function acceptInformativa(page, log) {
  const url = page.url();
  if (!url.includes('/informativa/accept')) return false;
  log(`Pagina informativa post-login rilevata (${redactUrl(url)}). Clicco conferma...`);
  try {
    let btn = page.locator('form[id^="accept_"] button[type="submit"]').first();
    if (await btn.count().catch(() => 0) === 0) {
      // Fallback: qualsiasi submit primario nella pagina
      btn = page.locator('button[type="submit"].btn-primary').first();
      if (await btn.count().catch(() => 0) === 0) {
        log('Bottone conferma informativa non trovato.');
        return false;
      }
    }
    await btn.click().catch(e => log(`Errore click conferma informativa: ${e.message}`));
    await page.waitForTimeout(4000);
    log(`Dopo conferma informativa: URL = ${redactUrl(page.url())}`);
    return true;
  } catch (e) {
    log(`Errore gestione conferma informativa: ${e.message}`);
    return false;
  }
}

// Gestisce il modal "Dichiarazione di fruizione" che appare direttamente sulla
// pagina /corso/show/XXXX. La piattaforma non registra i progressi delle lezioni
// (e non sblocca il quiz/attestato) finché l'utente non clicca "Confermo e proseguo".
async function acceptUsageDeclaration(page, log) {
  try {
    const needsAcceptance = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (!/Dichiarazione di fruizione|Confermo e proseguo/i.test(bodyText)) return false;
      const btn = [...document.querySelectorAll('button')].find(b => /confermo e proseguo/i.test(b.innerText));
      return btn ? { found: true, text: btn.innerText.trim() } : { found: false };
    }).catch(() => ({ found: false }));
    if (!needsAcceptance.found) return false;
    log(`Dichiarazione di fruizione rilevata. Accetto e proseguo...`);
    const btn = page.locator('button:has-text("Confermo e proseguo")').first();
    const form = page.locator('#conferma_vincolo_orario_form');
    const checkboxes = await form.locator('input[type="checkbox"]').all();
    for (const cb of checkboxes) {
      await cb.check().catch(() => {});
    }
    await btn.click({ force: true }).catch(e => log(`Errore click 'Confermo e proseguo': ${e.message}`));
    await page.waitForTimeout(4000);

    // Fallback: se il modal SweetAlert rimane aperto e blocca i click futuri, rimuovilo dal DOM.
    await page.evaluate(() => {
      const swal = document.querySelector('.swal2-container');
      if (swal) swal.remove();
    }).catch(() => {});

    log(`Dopo dichiarazione: URL = ${redactUrl(page.url())}`);
    return true;
  } catch (e) {
    log(`Errore accettazione dichiarazione: ${e.message}`);
    return false;
  }
}

module.exports = {
  handlePostLoginInterstitial,
  handleCourseInformativa,
  acceptInformativa,
  acceptUsageDeclaration,
};
