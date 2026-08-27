'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildIdempotencyKey,
  extractEffectState,
  normalizeMergeMethod,
  parseBoolean,
  parsePullNumber,
  parseTimeoutSeconds,
  retryDelay,
  mergeEffectState,
} = require('../index.js');

const intent = {
  owner: 'acme',
  repo: 'widget',
  pull_number: 42,
  expected_head_sha: 'a'.repeat(40),
  expected_base: 'main',
  expected_base_sha: 'b'.repeat(40),
  merge_method: 'squash',
  require_successful_checks: true,
};

test('buildIdempotencyKey is deterministic and input-bound', () => {
  const first = buildIdempotencyKey(intent);
  const second = buildIdempotencyKey({ ...intent });
  const changed = buildIdempotencyKey({ ...intent, expected_head_sha: 'c'.repeat(40) });
  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(first, /^tookeffect-action-merge-[a-f0-9]{64}$/);
});

test('extractEffectState reads canonical REST response fields', () => {
  assert.deepEqual(
    extractEffectState({ effectId: 'eff_123', status: 'completed', verdict: 'APPLIED', reason: 'Verified' }),
    { effectId: 'eff_123', status: 'COMPLETED', verdict: 'APPLIED', reason: 'Verified' },
  );
});

test('input parsers fail closed on invalid values', () => {
  assert.equal(parseBoolean('TRUE', 'checks'), true);
  assert.equal(parseBoolean('false', 'checks'), false);
  assert.throws(() => parseBoolean('yes', 'checks'));
  assert.equal(normalizeMergeMethod('REBASE'), 'rebase');
  assert.throws(() => normalizeMergeMethod('auto'));
  assert.equal(parsePullNumber('42'), 42);
  assert.throws(() => parsePullNumber('0'));
  assert.equal(parseTimeoutSeconds('90'), 90);
  assert.throws(() => parseTimeoutSeconds('10'));
  assert.throws(() => parseTimeoutSeconds('301'));
});

test('retryDelay defaults to two seconds when Retry-After is absent', () => {
  const response = { headers: { get: () => null } };
  assert.equal(retryDelay(response), 2000);
});

test('mergeEffectState preserves known fields across partial retry responses', () => {
  assert.deepEqual(
    mergeEffectState(
      { effectId: 'eff_123', status: 'RUNNING', verdict: '', reason: '' },
      { effectId: '', status: '', verdict: '', reason: 'temporary' },
    ),
    { effectId: 'eff_123', status: 'RUNNING', verdict: '', reason: 'temporary' },
  );
});
