const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const contractPath = path.join(ROOT, 'docs', 'ai-contract.json');

describe('ai-contract.json', () => {
  it('exists and parses', () => {
    const raw = fs.readFileSync(contractPath, 'utf8');
    const c = JSON.parse(raw);
    assert.equal(c.project, 'gsdcampus-autoplay');
    assert.ok(c.paths);
    assert.ok(c.commands);
    assert.ok(c.exit_codes);
  });

  it('referenced entrypoint paths exist', () => {
    const c = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    for (const rel of Object.values(c.entrypoints)) {
      const p = path.join(ROOT, rel);
      assert.ok(fs.existsSync(p), `missing entrypoint ${rel}`);
    }
    // Key docs
    for (const key of ['roadmap', 'security', 'runbook_keys']) {
      const rel = c.paths[key];
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    }
    // Source modules that contract assumes
    for (const rel of [
      'src/autoplay.js',
      'src/lib/quiz.js',
      'src/lib/course-runner.js',
      'src/lib/session-policy.js',
    ]) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
    }
  });
});
