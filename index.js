'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const TOOKEFFECT_ORIGIN = 'https://tookeffect.com';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const POLL_DELAY_MS = 2000;

function getInput(name, { required = false } = {}) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = (process.env[key] || '').trim();
  if (required && !value) {
    throw new Error(`Missing required input: ${name}`);
  }
  return value;
}

function parseBoolean(value, name) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function normalizeMergeMethod(value) {
  const method = String(value || 'squash').trim().toLowerCase();
  if (!['merge', 'squash', 'rebase'].includes(method)) {
    throw new Error('merge-method must be one of: merge, squash, rebase.');
  }
  return method;
}

function parsePullNumber(value) {
  const pullNumber = Number(value);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('pull-number must be a positive integer.');
  }
  return pullNumber;
}

function parseTimeoutSeconds(value) {
  const seconds = Number(value || '90');
  if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 300) {
    throw new Error('timeout-seconds must be an integer between 15 and 300.');
  }
  return seconds;
}

function buildIdempotencyKey(intent) {
  const canonical = JSON.stringify([
    intent.owner,
    intent.repo,
    intent.pull_number,
    intent.expected_head_sha,
    intent.expected_base,
    intent.expected_base_sha,
    intent.merge_method,
    intent.require_successful_checks,
  ]);
  const digest = crypto.createHash('sha256').update(canonical).digest('hex');
  return `tookeffect-action-merge-${digest}`;
}

function extractEffectState(data) {
  if (!data || typeof data !== 'object') {
    return { effectId: '', status: '', verdict: '', reason: '' };
  }
  return {
    effectId: stringValue(data.effectId || data.effect_id || data.effect?.id),
    status: stringValue(data.status || data.effect?.status).toUpperCase(),
    verdict: stringValue(data.verdict || data.effect?.verdict).toUpperCase(),
    reason: stringValue(data.reason || data.effect?.reason || data.message),
  };
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function commandEscape(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function addMask(value) {
  if (value) process.stdout.write(`::add-mask::${commandEscape(value)}\n`);
}

function writeOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  const delimiter = `TOOKEFFECT_${crypto.randomBytes(12).toString('hex')}`;
  fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${String(value || '')}\n${delimiter}\n`, 'utf8');
}

function writeSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, markdown, 'utf8');
}

function notice(message) {
  process.stdout.write(`::notice title=Verified by TookEffect::${commandEscape(message)}\n`);
}

function warning(message) {
  process.stdout.write(`::warning title=TookEffect::${commandEscape(message)}\n`);
}

function errorAnnotation(message) {
  process.stdout.write(`::error title=TookEffect::${commandEscape(message)}\n`);
}

function markdownInline(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+.!|<>])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 1000) };
  }
}

async function githubGet(path, token) {
  const response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tookeffect-action',
    },
    signal: AbortSignal.timeout(30000),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const detail = data.message ? `: ${data.message}` : '';
    throw new Error(`GitHub API ${response.status}${detail}`);
  }
  return data;
}

async function resolvePullIntent({ repository, pullNumber, githubToken, mergeMethod, requireSuccessfulChecks }) {
  const slash = repository.indexOf('/');
  if (slash <= 0 || slash === repository.length - 1) {
    throw new Error('GITHUB_REPOSITORY is missing or invalid.');
  }
  const owner = repository.slice(0, slash);
  const repo = repository.slice(slash + 1);

  const pr = await githubGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`, githubToken);
  const baseRef = stringValue(pr.base?.ref);
  const headSha = stringValue(pr.head?.sha);
  if (!baseRef || !headSha) {
    throw new Error('GitHub did not return the pull request head SHA and base branch.');
  }
  if (pr.base?.repo?.full_name && pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('The pull request base repository does not match GITHUB_REPOSITORY.');
  }
  if (pr.state && pr.state !== 'open') {
    throw new Error(`Pull request #${pullNumber} is not open (state: ${pr.state}).`);
  }

  const branch = await githubGet(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(baseRef)}`,
    githubToken,
  );
  const baseSha = stringValue(branch.commit?.sha);
  if (!baseSha) throw new Error(`GitHub did not return the current SHA for base branch ${baseRef}.`);

  return {
    owner,
    repo,
    pull_number: pullNumber,
    expected_head_sha: headSha,
    expected_base: baseRef,
    expected_base_sha: baseSha,
    merge_method: mergeMethod,
    require_successful_checks: requireSuccessfulChecks,
  };
}

function retryDelay(response) {
  const value = Number(response.headers.get('retry-after'));
  if (Number.isFinite(value) && value >= 0) return Math.min(value * 1000, 10000);
  return POLL_DELAY_MS;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runVerifiedMerge({ token, intent, timeoutSeconds, onState = () => {} }) {
  const body = JSON.stringify(intent);
  const idempotencyKey = buildIdempotencyKey(intent);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastState = { effectId: '', status: '', verdict: '', reason: '' };
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const remaining = Math.max(1000, deadline - Date.now());
    let response;
    try {
      response = await fetch(`${TOOKEFFECT_ORIGIN}/api/v1/effects/github/merge-pull-request`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'User-Agent': 'tookeffect-action',
        },
        body,
        signal: AbortSignal.timeout(Math.min(60000, remaining)),
      });
    } catch {
      if (Date.now() >= deadline) break;
      warning(`TookEffect response was not received on attempt ${attempt}; retrying the identical intent with the same idempotency key.`);
      await sleep(Math.min(POLL_DELAY_MS, Math.max(0, deadline - Date.now())));
      continue;
    }

    const data = await readJsonResponse(response);
    lastState = { ...lastState, ...extractEffectState(data) };
    onState(lastState);

    if (response.status === 200) {
      if (!['APPLIED', 'NOT_APPLIED', 'AMBIGUOUS'].includes(lastState.verdict)) {
        throw new Error(`TookEffect returned HTTP 200 without a recognized final verdict${lastState.status ? ` (status: ${lastState.status})` : ''}.`);
      }
      return { ...lastState, idempotencyKey };
    }

    if (response.status === 202 || response.status === 429 || response.status >= 500) {
      if (Date.now() >= deadline) break;
      await sleep(Math.min(retryDelay(response), Math.max(0, deadline - Date.now())));
      continue;
    }

    const detail = lastState.reason || data.error || data.message || `HTTP ${response.status}`;
    throw new Error(`TookEffect rejected the request (${response.status}): ${stringValue(detail)}`);
  }

  const pending = lastState.effectId ? ` Effect: ${lastState.effectId}.` : '';
  throw new Error(`TookEffect did not produce a final verdict within ${timeoutSeconds} seconds.${pending} Do not infer success; retry only with the identical intent and idempotency key.`);
}

function publishOutputs(state) {
  const receiptUrl = state.effectId ? `${TOOKEFFECT_ORIGIN}/api/v1/receipts/${encodeURIComponent(state.effectId)}` : '';
  const receiptKeysUrl = `${TOOKEFFECT_ORIGIN}/api/v1/receipt-keys`;
  writeOutput('effect-id', state.effectId);
  writeOutput('verdict', state.verdict);
  writeOutput('reason', state.reason);
  writeOutput('receipt-url', receiptUrl);
  writeOutput('receipt-keys-url', receiptKeysUrl);
  return { receiptUrl, receiptKeysUrl };
}

function renderSummary(state, links) {
  const verdict = state.verdict || 'NO FINAL VERDICT';
  const icon = verdict === 'APPLIED' ? '✅' : verdict === 'NOT_APPLIED' ? '⛔' : '⚠️';
  const lines = [
    `## ${icon} Verified by [TookEffect](${TOOKEFFECT_ORIGIN})`,
    '',
    `**Verdict:** \`${verdict}\``,
  ];
  if (state.effectId) lines.push(`**Effect:** \`${markdownInline(state.effectId)}\``);
  if (state.reason) lines.push(`**Reason:** ${markdownInline(state.reason)}`);
  if (links.receiptUrl) lines.push(`**Receipt API:** [Open authenticated receipt](${links.receiptUrl})`);
  lines.push(`**Public verification keys:** [JWKS](${links.receiptKeysUrl})`);
  lines.push('', '_An API response alone is not proof. TookEffect returns `APPLIED` only after authoritative read-back proves the requested effect._', '');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const tookeffectToken = getInput('tookeffect-token', { required: true });
  const githubToken = getInput('github-token', { required: true });
  addMask(tookeffectToken);
  addMask(githubToken);

  const pullNumber = parsePullNumber(getInput('pull-number', { required: true }));
  const mergeMethod = normalizeMergeMethod(getInput('merge-method') || 'squash');
  const requireSuccessfulChecks = parseBoolean(getInput('require-successful-checks') || 'true', 'require-successful-checks');
  const timeoutSeconds = parseTimeoutSeconds(getInput('timeout-seconds') || '90');
  const repository = (process.env.GITHUB_REPOSITORY || '').trim();

  console.log(`Resolving exact GitHub state for ${repository}#${pullNumber}...`);
  const intent = await resolvePullIntent({ repository, pullNumber, githubToken, mergeMethod, requireSuccessfulChecks });
  console.log(`Bound intent to head ${intent.expected_head_sha.slice(0, 12)} and ${intent.expected_base}@${intent.expected_base_sha.slice(0, 12)}.`);

  let lastEffectId = '';
  const state = await runVerifiedMerge({
    token: tookeffectToken,
    intent,
    timeoutSeconds,
    onState: (current) => {
      if (current.effectId && current.effectId !== lastEffectId) {
        lastEffectId = current.effectId;
        console.log(`TookEffect Effect: ${current.effectId}`);
      }
    },
  });

  const links = publishOutputs(state);
  writeSummary(renderSummary(state, links));

  if (state.verdict === 'APPLIED') {
    notice(`APPLIED — TookEffect independently verified the merge${state.effectId ? ` (${state.effectId})` : ''}. ${TOOKEFFECT_ORIGIN}`);
    console.log('TookEffect verdict: APPLIED');
    return;
  }

  const reason = state.reason ? ` ${state.reason}` : '';
  if (state.verdict === 'NOT_APPLIED') {
    throw new Error(`TookEffect verdict: NOT_APPLIED.${reason}`);
  }
  throw new Error(`TookEffect verdict: AMBIGUOUS.${reason} Do not infer success or retry with a new idempotency key.`);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    errorAnnotation(message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildIdempotencyKey,
  extractEffectState,
  markdownInline,
  normalizeMergeMethod,
  parseBoolean,
  parsePullNumber,
  parseTimeoutSeconds,
};
