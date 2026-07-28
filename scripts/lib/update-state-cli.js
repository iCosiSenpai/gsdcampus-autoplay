#!/usr/bin/env node
/**
 * update-state-cli.js — stato dell'auto-aggiornamento periodico.
 *
 *   node scripts/lib/update-state-cli.js mark <esito> [--detail "..."] \
 *        [--local <sha>] [--remote <sha>] [--updated-to <sha>]
 *        Registra un giro di auto-update (usato da scripts/auto-update.sh a OGNI
 *        giro, anche quando non c'è niente di nuovo). Esiti: up_to_date,
 *        updated, rollback, postponed, deps_required, update_failed, offline,
 *        disabled.
 *
 *   node scripts/lib/update-state-cli.js show [--json]
 *        Stampa "controllato 4m fa · già all'ultima versione (964824c)".
 *        Usato da status.sh; la plancia usa direttamente src/lib/update-state.js.
 *
 * Exit 0 sempre (è informativo: non deve mai far fallire chi lo chiama).
 */

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const {
  markUpdateState, readUpdateState, describeUpdateState, isAgentInstalled, isAutoUpdateDisabled,
} = require(path.join(ROOT, 'src', 'lib', 'update-state'));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2] || 'show';

if (cmd === 'mark') {
  markUpdateState(ROOT, {
    result: process.argv[3],
    detail: argValue('--detail'),
    localVersion: argValue('--local'),
    remoteVersion: argValue('--remote'),
    updatedTo: argValue('--updated-to'),
  });
} else if (cmd === 'show') {
  const state = readUpdateState(ROOT);
  const described = describeUpdateState(state, Date.now(), {
    agentInstalled: isAgentInstalled(),
    disabled: isAutoUpdateDisabled(ROOT),
  });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...described, state }));
  } else {
    console.log(described.text);
  }
} else {
  console.error('Uso: update-state-cli.js mark <esito> [opzioni] | show [--json]');
}
process.exit(0);
