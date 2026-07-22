/**
 * Snapshot recuperabili del solo course_state per-account.
 *
 * I backup vivono in backups/ (gitignored), non includono cookie, autologin o
 * members.db e sono legati al CF attivo. Ogni file porta l'hash SHA-256 dello
 * snapshot: un restore rifiuta file corrotti o appartenenti a un altro account.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const account = require('./account');
const { writeJsonAtomic, readJsonSafe } = require('./io');

const SCHEMA_VERSION = 1;
const DEFAULT_KEEP = 30;

function snapshotJson(snapshot) {
  return JSON.stringify(snapshot && typeof snapshot === 'object' ? snapshot : {});
}

function snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(snapshotJson(snapshot)).digest('hex');
}

function safePart(value, fallback) {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function backupDir(root, cf = null) {
  const paths = account.stateFilePaths(root, cf);
  const owner = safePart(cf || paths.codiceFiscale || 'legacy', 'legacy');
  return path.join(root, 'backups', 'accounts', owner, 'course-state');
}

function pruneBackups(dir, keep = DEFAULT_KEEP) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (_) {
    return;
  }
  for (const item of files.slice(Math.max(0, keep))) {
    try { fs.unlinkSync(path.join(dir, item.name)); } catch (_) { /* best-effort */ }
  }
}

function createCourseStateBackup(root, state, meta = {}) {
  const paths = account.stateFilePaths(root, meta.cf || null);
  const cf = paths.codiceFiscale || null;
  const snapshot = state && typeof state === 'object' ? state : {};
  const sha256 = snapshotHash(snapshot);
  const createdAt = new Date().toISOString();
  const dir = backupDir(root, cf);
  const stamp = createdAt.replace(/[:.]/g, '-');
  const reason = safePart(meta.reason, 'state-change');
  const courseId = safePart(meta.courseId, 'all');
  const file = path.join(dir, `${stamp}-${reason}-${courseId}-${sha256.slice(0, 10)}.json`);
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    createdAt,
    account: cf || 'legacy',
    reason: meta.reason || 'state-change',
    courseId: meta.courseId || null,
    source: path.relative(root, paths.courseState),
    sha256,
    snapshot,
  };
  writeJsonAtomic(file, envelope);
  pruneBackups(dir, Number.isInteger(meta.keep) ? meta.keep : DEFAULT_KEEP);
  return { file, sha256, envelope };
}

function listCourseStateBackups(root) {
  const paths = account.stateFilePaths(root);
  const dir = backupDir(root, paths.codiceFiscale || null);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse(); } catch (_) {}
  return names.map((name) => {
    const file = path.join(dir, name);
    const data = readJsonSafe(file, null, { warn: false });
    return {
      name,
      file,
      valid: !!(data && data.sha256 && snapshotHash(data.snapshot) === data.sha256),
      createdAt: data?.createdAt || null,
      account: data?.account || null,
      reason: data?.reason || null,
      courseId: data?.courseId || null,
      sha256: data?.sha256 || null,
    };
  });
}

function resolveBackupFile(root, name) {
  if (!name || path.basename(String(name)) !== String(name)) {
    throw new Error('backup_name_invalid');
  }
  const paths = account.stateFilePaths(root);
  return path.join(backupDir(root, paths.codiceFiscale || null), String(name));
}

function restoreCourseStateBackup(root, name) {
  const paths = account.stateFilePaths(root);
  const file = resolveBackupFile(root, name);
  const data = readJsonSafe(file, null, { warn: false });
  if (!data || data.schemaVersion !== SCHEMA_VERSION || !data.snapshot || !data.sha256) {
    throw new Error('backup_invalid');
  }
  if (snapshotHash(data.snapshot) !== data.sha256) throw new Error('backup_checksum_mismatch');
  const active = paths.codiceFiscale || 'legacy';
  if (data.account !== active) throw new Error('backup_account_mismatch');

  const current = readJsonSafe(paths.courseState, {});
  const safety = createCourseStateBackup(root, current, { reason: 'before-restore', courseId: 'all' });
  writeJsonAtomic(paths.courseState, data.snapshot);
  return { restoredFrom: file, safetyBackup: safety.file, sha256: data.sha256 };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_KEEP,
  snapshotHash,
  backupDir,
  createCourseStateBackup,
  listCourseStateBackups,
  restoreCourseStateBackup,
};
