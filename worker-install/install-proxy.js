/**
 * install-proxy.js — Worker Cloudflare dedicato: serve install.sh dalla radice.
 *
 * Scopo: dare ai colleghi un comando d'installazione CORTO e digitabile a mano,
 * così non devono copiare un URL lungo (che, copiato come "link", si rompe:
 * zsh interpreta la parte tra parentesi come glob → "unknown file attribute").
 *
 *   curl -fsSL https://gsd.<account>.workers.dev | bash
 *
 * È un semplice proxy in SOLA LETTURA verso raw.githubusercontent (branch main):
 * nessun segreto, nessun token, nessuna scrittura. Cache 60s per non martellare
 * GitHub e per riflettere gli aggiornamenti di install.sh entro un minuto.
 */
const UPSTREAM = 'https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh';

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed\n', {
        status: 405,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

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
