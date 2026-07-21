/**
 * Lock single-instance con identità, non solo PID.
 *
 * Il PID può essere riciclato dal sistema. Il lock conserva anche un token
 * casuale passato nella command line dello scheduler; un processo è nostro solo
 * se PID, tipo di comando e token coincidono.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeJsonAtomic, readJsonSafe } = require('./io');

const SCHEMA_VERSION = 1;
const TOKEN_RE = /^[a-f0-9]{24,128}$/i;

function lockDir(root) { return path.join(path.resolve(root), '.autoplay_lock'); }
function ownerFile(root) { return path.join(lockDir(root), 'owner.json'); }

function commandForPid(pid) {
  try {
    return String(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000,
    }) || '').trim();
  } catch (_) { return ''; }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (_) { return false; }
}

function validOwner(owner) {
  return !!(owner
    && owner.schemaVersion === SCHEMA_VERSION
    && Number.isInteger(Number(owner.pid))
    && Number(owner.pid) > 1
    && TOKEN_RE.test(String(owner.token || ''))
    && (owner.kind === 'starting' || owner.kind === 'scheduler'));
}

function ownerMatches(owner, deps = {}) {
  if (!validOwner(owner)) return false;
  const alive = deps.pidAlive || pidAlive;
  const command = deps.commandForPid || commandForPid;
  if (!alive(Number(owner.pid))) return false;
  const cmd = String(command(Number(owner.pid)) || '');
  if (!cmd) return false;
  if (owner.kind === 'starting') return /(^|[/\s])start\.sh(\s|$)/.test(cmd);
  return /scheduler\.sh/.test(cmd) && cmd.includes(String(owner.token));
}

function readOwner(root) {
  return readJsonSafe(ownerFile(root), null, { warn: false });
}

function inspectLock(root, deps = {}) {
  const owner = readOwner(root);
  return { exists: fs.existsSync(lockDir(root)), alive: ownerMatches(owner, deps), owner };
}

function removeExactLockDir(root) {
  const dir = lockDir(root);
  if (path.dirname(dir) !== path.resolve(root)) throw new Error('unsafe_lock_path');
  fs.rmSync(dir, { recursive: true, force: true });
}

function acquireLock(root, { pid, token }) {
  if (!TOKEN_RE.test(String(token || ''))) return { ok: false, reason: 'invalid_token' };
  const dir = lockDir(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      const owner = {
        schemaVersion: SCHEMA_VERSION,
        pid: Number(pid),
        token: String(token),
        kind: 'starting',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeJsonAtomic(ownerFile(root), owner);
      return { ok: true, owner, recoveredStale: attempt > 0 };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: e.message };
      const current = inspectLock(root);
      if (current.alive) return { ok: false, reason: 'active', owner: current.owner };
      const quarantine = `${dir}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(dir, quarantine);
        fs.rmSync(quarantine, { recursive: true, force: true });
      } catch (_) {
        // Un altro start può aver recuperato il lock: il secondo mkdir decide.
      }
    }
  }
  return { ok: false, reason: 'lock_race' };
}

function promoteLock(root, token, pid) {
  const owner = readOwner(root);
  if (!validOwner(owner) || owner.token !== String(token)) return { ok: false, reason: 'not_owner' };
  const next = { ...owner, pid: Number(pid), kind: 'scheduler', updatedAt: new Date().toISOString() };
  writeJsonAtomic(ownerFile(root), next);
  return { ok: true, owner: next };
}

function releaseLock(root, token) {
  const owner = readOwner(root);
  if (!owner) return { ok: true, released: false };
  if (owner.token !== String(token)) return { ok: false, reason: 'not_owner' };
  removeExactLockDir(root);
  return { ok: true, released: true };
}

function lockOwnedBy(root, token, pid) {
  const owner = readOwner(root);
  return !!(validOwner(owner)
    && owner.kind === 'scheduler'
    && owner.token === String(token)
    && Number(owner.pid) === Number(pid));
}

function cleanStaleLock(root) {
  const status = inspectLock(root);
  if (!status.exists) return { ok: true, removed: false };
  if (status.alive) return { ok: false, reason: 'active', owner: status.owner };
  removeExactLockDir(root);
  return { ok: true, removed: true };
}

module.exports = {
  SCHEMA_VERSION,
  TOKEN_RE,
  lockDir,
  ownerFile,
  commandForPid,
  pidAlive,
  validOwner,
  ownerMatches,
  readOwner,
  inspectLock,
  acquireLock,
  promoteLock,
  releaseLock,
  lockOwnedBy,
  cleanStaleLock,
};
