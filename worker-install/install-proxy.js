/**
 * install-proxy.js — Worker Cloudflare dedicato "gsd".
 *
 * Rotte (tutte GET, pubbliche, sola lettura — nessun segreto):
 *   GET /        → serve install.sh (branch main). Comando corto:
 *                    curl -fsSL https://gsd.<account>.workers.dev | bash
 *   GET /avvia   → scarica "GSD Avvia.zip": dentro c'è "GSD Avvia.command" GIÀ
 *                  ESEGUIBILE (755). Safari lo espande da solo → doppio clic e
 *                  parte. È il metodo a prova di copia-incolla per i colleghi.
 *   GET /avvia.command → lo script nudo (fallback per chi lo vuole diretto; va
 *                  reso eseguibile a mano: chmod +x).
 *
 * Perché lo ZIP: HTTP non trasporta i permessi dei file, quindi un .command
 * scaricato dal browser arriva 644 e il doppio clic risponde "could not be
 * executed because you do not have appropriate access privileges" — il Modo A
 * non partiva. Lo ZIP porta i permessi Unix e risolve alla radice.
 *
 * Perché non il link "azzurro": l'URL copiato come link da un'app diventa
 * `url (url)` e zsh interpreta `(h…` come glob qualifier → "unknown file
 * attribute: h". Col file scaricabile il collega non copia né scrive niente.
 */
import { buildStoredZip } from './zip-store.js';

const UPSTREAM = 'https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh';

// Contenuto del file eseguibile. Doppio clic → apre il Terminale, scarica
// install.sh SEMPRE fresco da main (quindi aggiorna) e lo esegue.
// Prima volta: Gatekeeper può bloccare → tasto destro → Apri.
const COMMAND_FILE =
  '#!/bin/bash\n' +
  '# GSD Campus Autopilot — doppio clic per installare/aggiornare e avviare.\n' +
  '# Prima volta: se il Mac blocca l\'apertura, tasto destro sul file -> Apri -> Apri.\n' +
  'curl -fsSL ' + UPSTREAM + ' | bash\n';

const COMMAND_NAME = 'GSD Avvia.command';

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

    // Script nudo (fallback esplicito): serve `chmod +x` per il doppio clic.
    if (path === '/avvia.command' || path === '/command') {
      return new Response(COMMAND_FILE, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${COMMAND_NAME}"`,
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    // Download consigliato: ZIP con il .command già eseguibile (755).
    if (path === '/avvia' || path === '/mac' || path === '/download') {
      const zip = buildStoredZip([
        { name: COMMAND_NAME, data: COMMAND_FILE, mode: 0o100755 },
      ]);
      return new Response(zip, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="GSD Avvia.zip"',
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
