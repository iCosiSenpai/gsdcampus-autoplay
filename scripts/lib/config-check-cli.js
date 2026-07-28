#!/usr/bin/env node
/**
 * config-check-cli.js — config.json è completo (account + orari)?
 *
 * Exit 0 = completo · Exit 1 = da configurare/completare.
 * Stampa il motivo su stdout ('ok', 'missing_file', 'bad_json',
 * 'missing_autologin', 'missing_schedule'); con --json l'oggetto completo.
 *
 * Usato da setup.sh (is_config_valid) e launch-ai-supervisor.sh per accorgersi
 * di una prima configurazione interrotta a metà, dove gli orari mancano ma
 * src/lib/schedule.js ripiegherebbe sui default senza dire nulla.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { checkConfig } = require(path.join(ROOT, 'src', 'lib', 'config-check'));

const result = checkConfig(ROOT);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result));
} else {
  console.log(result.reason);
}
process.exit(result.ok ? 0 : 1);
