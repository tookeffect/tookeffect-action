'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Exercise the actual Action entry point. All HTTP requests are intercepted;
// these tests cannot execute a GitHub merge or contact TookEffect.
for (const [verdict, label, exitCode] of [
  ['APPLIED', 'Verified', 0],
  ['NOT_APPLIED', 'Not applied', 1],
  ['AMBIGUOUS', 'Needs review', 1],
]) {
  test(`${verdict}: truthful summary, unchanged output and exit status`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tookeffect-action-'));
    try {
      const summary = path.join(dir, 'summary.md');
      const output = path.join(dir, 'output.txt');
      const mock = `
        import assert from 'node:assert/strict';
        globalThis.fetch = async (url, init = {}) => {
          if (url === 'https://api.github.com/repos/acme/widget/pulls/42') {
            return Response.json({ state: 'open', head: { sha: 'a'.repeat(40) }, base: { ref: 'main', repo: { full_name: 'acme/widget' } } });
          }
          if (url === 'https://api.github.com/repos/acme/widget/branches/main') {
            return Response.json({ commit: { sha: 'b'.repeat(40) } });
          }
          if (url === 'https://tookeffect.com/api/v1/effects/github/merge-pull-request') {
            assert.equal(init.method, 'POST');
            assert.match(init.headers['Idempotency-Key'], /^tookeffect-action-merge-[a-f0-9]{64}$/);
            assert.equal(JSON.parse(init.body).expected_head_sha, 'a'.repeat(40));
            return Response.json({ effectId: 'eff_test', status: 'completed', verdict: ${JSON.stringify(verdict)}, reason: 'Provider evidence checked.' });
          }
          throw new Error('Unexpected network request: ' + url);
        };
      `;
      const child = spawnSync(process.execPath, [
        '--import', `data:text/javascript,${encodeURIComponent(mock)}`,
        path.resolve(__dirname, '../index.js'),
      ], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          'INPUT_TOOKEFFECT-TOKEN': 'test-only-tookeffect-token',
          'INPUT_GITHUB-TOKEN': 'test-only-github-token',
          'INPUT_PULL-NUMBER': '42',
          GITHUB_REPOSITORY: 'acme/widget',
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
        },
      });
      assert.ifError(child.error);
      assert.equal(child.status, exitCode, child.stdout + child.stderr);
      const markdown = fs.readFileSync(summary, 'utf8');
      assert.match(markdown.split('\n')[0], new RegExp(`${label} — \\[TookEffect\\]`));
      if (verdict !== 'APPLIED') assert.doesNotMatch(markdown.split('\n')[0], /Verified/);
      assert.ok(markdown.includes('**API verdict:** `' + verdict + '`'));
      assert.match(markdown, /https:\/\/tookeffect\.com\/api\/v1\/receipts\/eff_test/);
      assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`verdict<<[^\\n]+\\n${verdict}\\n`));
      assert.match(child.stdout, new RegExp(`${label} \\(${verdict}\\)`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
