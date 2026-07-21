/**
 * Budget locale per le chiamate al supervisore AI.
 *
 * Il file persistito contiene esclusivamente metadati di conteggio: timestamp,
 * modello, endpoint ed esito HTTP. Prompt, risposte e credenziali non vengono
 * mai scritti su disco.
 */

const crypto = require('crypto');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./io');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WEEK_MS = 7 * DAY_MS;

const DEFAULT_LIMITS = Object.freeze({
  weekly: 400,
  daily: 80,
  perMinute: 8,
  minIntervalMs: 1500,
  maxConcurrent: 1,
});

// Limiti assoluti intenzionalmente prudenti per il tier gratuito. Il piano di
// Ollama è espresso in tempo GPU, non in un numero garantito di richieste.
const HARD_MAX = Object.freeze({ weekly: 500, daily: 100, perMinute: 10, maxConcurrent: 1 });

function integerInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function readLimits(root = process.cwd()) {
  const cfg = readJsonSafe(path.join(root, 'config.json'), {}, { warn: false });
  return {
    weekly: integerInRange(cfg.aiWeeklyRequestLimit, DEFAULT_LIMITS.weekly, 1, HARD_MAX.weekly),
    daily: integerInRange(cfg.aiDailyRequestLimit, DEFAULT_LIMITS.daily, 1, HARD_MAX.daily),
    perMinute: integerInRange(cfg.aiPerMinuteRequestLimit, DEFAULT_LIMITS.perMinute, 1, HARD_MAX.perMinute),
    minIntervalMs: integerInRange(cfg.aiMinRequestIntervalMs, DEFAULT_LIMITS.minIntervalMs, 250, 60_000),
    maxConcurrent: integerInRange(cfg.aiMaxConcurrentRequests, DEFAULT_LIMITS.maxConcurrent, 1, HARD_MAX.maxConcurrent),
  };
}

function stateFile(root = process.cwd()) {
  return path.join(root, 'data', 'ai_usage.json');
}

function eventTime(event) {
  const value = Date.parse(event && event.at);
  return Number.isFinite(value) ? value : 0;
}

function normalizeState(raw) {
  const events = Array.isArray(raw && raw.events)
    ? raw.events.filter((event) => event && typeof event === 'object' && eventTime(event) > 0)
    : [];
  return { version: 1, events };
}

function pruneEvents(events, nowMs = Date.now()) {
  // Un giorno extra agevola diagnosi senza far crescere il file all'infinito.
  return events.filter((event) => eventTime(event) >= nowMs - WEEK_MS - DAY_MS);
}

function countSince(events, sinceMs) {
  return events.reduce((total, event) => total + (eventTime(event) >= sinceMs ? 1 : 0), 0);
}

function firstExpiry(events, nowMs, windowMs) {
  const relevant = events.map(eventTime).filter((time) => time >= nowMs - windowMs).sort((a, b) => a - b);
  if (!relevant.length) return nowMs;
  return relevant[0] + windowMs;
}

function summarize(events, limits, nowMs = Date.now()) {
  const used = {
    weekly: countSince(events, nowMs - WEEK_MS),
    daily: countSince(events, nowMs - DAY_MS),
    perMinute: countSince(events, nowMs - MINUTE_MS),
  };
  return {
    limits,
    used,
    remaining: {
      weekly: Math.max(0, limits.weekly - used.weekly),
      daily: Math.max(0, limits.daily - used.daily),
      perMinute: Math.max(0, limits.perMinute - used.perMinute),
    },
    resetsAt: {
      weekly: new Date(firstExpiry(events, nowMs, WEEK_MS)).toISOString(),
      daily: new Date(firstExpiry(events, nowMs, DAY_MS)).toISOString(),
      perMinute: new Date(firstExpiry(events, nowMs, MINUTE_MS)).toISOString(),
    },
  };
}

function usageSummary(root = process.cwd(), nowMs = Date.now()) {
  const limits = readLimits(root);
  const state = normalizeState(readJsonSafe(stateFile(root), { version: 1, events: [] }, { warn: false }));
  return summarize(pruneEvents(state.events, nowMs), limits, nowMs);
}

function blockingWindow(events, limits, nowMs) {
  const windows = [
    ['perMinute', MINUTE_MS],
    ['daily', DAY_MS],
    ['weekly', WEEK_MS],
  ];
  for (const [name, duration] of windows) {
    const relevant = events.filter((event) => eventTime(event) >= nowMs - duration);
    if (relevant.length >= limits[name]) {
      const retryAt = firstExpiry(relevant, nowMs, duration);
      return { reason: name, retryAfterMs: Math.max(1000, retryAt - nowMs) };
    }
  }
  return null;
}

function reserveRequest(root = process.cwd(), metadata = {}, nowMs = Date.now()) {
  const limits = readLimits(root);
  const file = stateFile(root);
  const state = normalizeState(readJsonSafe(file, { version: 1, events: [] }, { warn: false }));
  state.events = pruneEvents(state.events, nowMs);

  const blocked = blockingWindow(state.events, limits, nowMs);
  if (blocked) {
    return { ok: false, ...blocked, summary: summarize(state.events, limits, nowMs) };
  }

  const event = {
    id: crypto.randomUUID(),
    at: new Date(nowMs).toISOString(),
    path: String(metadata.path || '').slice(0, 80),
    model: String(metadata.model || '').slice(0, 120),
    status: 'started',
  };
  state.events.push(event);
  writeJsonAtomic(file, state);
  return { ok: true, id: event.id, summary: summarize(state.events, limits, nowMs) };
}

function completeRequest(root = process.cwd(), id, httpStatus, metadata = {}) {
  if (!id) return false;
  const file = stateFile(root);
  const state = normalizeState(readJsonSafe(file, { version: 1, events: [] }, { warn: false }));
  const event = state.events.find((item) => item.id === id);
  if (!event) return false;
  event.status = metadata.error ? 'error' : 'complete';
  if (Number.isInteger(httpStatus)) event.httpStatus = httpStatus;
  writeJsonAtomic(file, state);
  return true;
}

module.exports = {
  DAY_MS,
  DEFAULT_LIMITS,
  HARD_MAX,
  MINUTE_MS,
  WEEK_MS,
  blockingWindow,
  completeRequest,
  normalizeState,
  pruneEvents,
  readLimits,
  reserveRequest,
  stateFile,
  summarize,
  usageSummary,
};
