/**
 * install-proxy.js — Worker Cloudflare dedicato "gsd".
 *
 * Rotte (tutte GET, pubbliche, sola lettura — nessun segreto):
 *   GET /        → serve install.sh (branch main). Comando corto:
 *                    curl -fsSL https://gsd.<account>.workers.dev | bash
 *   GET /avvia   → scarica un file "GSD Avvia.command" (doppio clic su Mac):
 *                  il metodo a prova di copia-incolla per i colleghi.
 *
 * Perché: l'URL, copiato come "link" da un'app, diventa `url (url)` e zsh
 * interpreta `(h…` come glob qualifier → "unknown file attribute: h". Con il
 * file .command il collega non copia né scrive niente: scarica e fa doppio clic.
 */
const UPSTREAM = 'https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh';

// Contenuto del file scaricabile. Doppio clic → apre il Terminale ed esegue
// l'installer. Prima volta: Gatekeeper può bloccare → tasto destro → Apri.
const COMMAND_FILE =
  '#!/bin/bash\n' +
  '# GSD Campus Autopilot — doppio clic per installare/aggiornare e avviare.\n' +
  '# Prima volta: se il Mac blocca l\'apertura, tasto destro sul file -> Apri -> Apri.\n' +
  'curl -fsSL ' + UPSTREAM + ' | bash\n';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed\n', {
        status: 405,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    // Download del file .command (doppio clic).
    if (path === '/avvia' || path === '/mac' || path === '/download') {
      return new Response(COMMAND_FILE, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="GSD Avvia.command"',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    // Root (o qualsiasi altro path): serve install.sh per `curl | bash`.
    const up = await fetch(UPSTREAM, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!up.ok) {
      return new Response('# impossibile scaricare install.sh (HTTP ' + up.status + ')\n', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    const script = await up.text();
    return new Response(script, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
};
