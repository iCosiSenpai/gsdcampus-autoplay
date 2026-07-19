/**
 * member-queue.js — coda multi-CF su un solo Mac (config.memberQueue).
 *
 * A fine corsi (o quando tutti done/need_help), avanza all'account successivo
 * scrivendo config.json (codice_fiscale + autologinUrl + memberName) dal DB.
 * Non avvia da sola: lo scheduler / restart successivo usa il nuovo active.
 *
 * config.memberQueue: string[] di CF (ordine).
 * config.memberQueueIndex: indice corrente (opzionale; se assente, cerca active).
 */

const path = require('path');
const { writeJsonAtomic } = require('./io');

function normalizeCf(cf) {
  return String(cf || '').trim().toUpperCase();
}

/**
 * Ritorna la coda normalizzata da config, o [].
 */
function getQueue(config) {
  const q = config && config.memberQueue;
  if (!Array.isArray(q) || q.length === 0) return [];
  return q.map(normalizeCf).filter(Boolean);
}

/**
 * Indice del CF attivo nella coda, o 0.
 */
function currentIndex(config) {
  const queue = getQueue(config);
  if (queue.length === 0) return -1;
  if (Number.isInteger(config.memberQueueIndex) && config.memberQueueIndex >= 0 && config.memberQueueIndex < queue.length) {
    return config.memberQueueIndex;
  }
  const active = normalizeCf(config.codice_fiscale);
  const i = queue.indexOf(active);
  return i >= 0 ? i : 0;
}

/**
 * Prossimo CF in coda (ciclico), o null se coda vuota / un solo membro.
 */
function peekNextCf(config) {
  const queue = getQueue(config);
  if (queue.length < 2) return null;
  const i = currentIndex(config);
  if (i < 0) return null;
  return queue[(i + 1) % queue.length];
}

/**
 * Carica membro da members.db (best-effort). Ritorna { cf, name, autologinUrl } o null.
 */
function loadMemberFromDb(root, cf) {
  try {
    const { getMember } = require('./db');
    const m = getMember(root, normalizeCf(cf));
    if (!m || !m.autologin_url) return null;
    const name = [m.nome, m.cognome].filter(Boolean).join(' ').trim() || null;
    return { cf: normalizeCf(m.codice_fiscale), name, autologinUrl: m.autologin_url };
  } catch (_) {
    return null;
  }
}

/**
 * Avanza la coda: aggiorna config.json con il prossimo membro.
 * @returns {{ ok: boolean, from?: string, to?: string, reason?: string }}
 */
function advanceMemberQueue(root, config, log) {
  const queue = getQueue(config);
  if (queue.length < 2) {
    return { ok: false, reason: 'queue_empty_or_single' };
  }
  const from = normalizeCf(config.codice_fiscale);
  const nextCf = peekNextCf(config);
  if (!nextCf) return { ok: false, reason: 'no_next' };
  if (nextCf === from) return { ok: false, reason: 'same' };

  const member = loadMemberFromDb(root, nextCf);
  if (!member || !member.autologinUrl) {
    if (log) log(`member-queue: CF ${nextCf} non trovato in members.db o senza autologinUrl.`);
    return { ok: false, reason: 'member_missing', to: nextCf };
  }

  const nextIndex = queue.indexOf(nextCf);
  const nextConfig = {
    ...config,
    codice_fiscale: member.cf,
    autologinUrl: member.autologinUrl,
    memberQueueIndex: nextIndex,
  };
  if (member.name) nextConfig.memberName = member.name;

  const cfgPath = path.join(root, 'config.json');
  try {
    writeJsonAtomic(cfgPath, nextConfig);
  } catch (e) {
    if (log) log(`member-queue: impossibile scrivere config.json: ${e.message}`);
    return { ok: false, reason: 'write_failed', to: nextCf };
  }
  if (log) {
    log(`member-queue: avanzato ${from || '?'} → ${member.cf}${member.name ? ` (${member.name})` : ''}. Riavvia per applicare.`);
  }
  return { ok: true, from, to: member.cf, name: member.name };
}

/**
 * Se la coda è attiva e i corsi del membro corrente sono tutti done/need_help,
 * avanza. Non riavvia processi.
 */
function maybeAdvanceOnAllDone(root, config, allDoneOrNeedHelp, log) {
  if (!allDoneOrNeedHelp) return { ok: false, reason: 'not_all_done' };
  if (getQueue(config).length < 2) return { ok: false, reason: 'no_queue' };
  return advanceMemberQueue(root, config, log);
}

module.exports = {
  getQueue,
  currentIndex,
  peekNextCf,
  loadMemberFromDb,
  advanceMemberQueue,
  maybeAdvanceOnAllDone,
  normalizeCf,
};
