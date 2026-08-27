# TookEffect Verified Merge

[![CI](https://github.com/tookeffect/tookeffect-action/actions/workflows/ci.yml/badge.svg)](https://github.com/tookeffect/tookeffect-action/actions/workflows/ci.yml)

**AI agents can act. TookEffect proves what actually took effect.**

`TookEffect Verified Merge` is a public GitHub Action for executing one exact pull request merge through [TookEffect](https://tookeffect.com) and receiving an authoritative final verdict.

A successful mutation response is not treated as proof. TookEffect binds the exact PR head and destination branch, executes through its authorized GitHub App, reads GitHub back, and returns one of:

| Verdict | Meaning |
| --- | --- |
| `APPLIED` | The requested merge was authoritatively proven on the destination branch. |
| `NOT_APPLIED` | Authoritative evidence establishes that the requested effect did not occur. |
| `AMBIGUOUS` | TookEffect cannot establish the external truth safely. The Action fails closed. |

##Verify your first AI action free → TookEffect.com

## Quick start

### 1. Connect GitHub to TookEffect

Sign in at [tookeffect.com](https://tookeffect.com), install the TookEffect GitHub App for the repository you want to use, and create a TookEffect Agent API token from the authenticated dashboard.

### 2. Add the token as a repository secret

Create a GitHub Actions secret named:

```text
TOOKEFFECT_TOKEN
```

Never commit the token to the repository.

### 3. Add a manual Verified Merge workflow

```yaml
name: TookEffect Verified Merge

on:
  workflow_dispatch:
    inputs:
      pull_number:
        description: Pull request number
        required: true
        type: number

permissions:
  contents: read
  pull-requests: read

jobs:
  verified-merge:
    runs-on: ubuntu-latest
    steps:
      - name: Merge and independently verify
        id: tookeffect
        uses: tookeffect/tookeffect-action@v1
        with:
          tookeffect-token: ${{ secrets.TOOKEFFECT_TOKEN }}
          github-token: ${{ github.token }}
          pull-number: ${{ inputs.pull_number }}
          merge-method: squash
          require-successful-checks: true
```

Run the workflow from the GitHub **Actions** tab and enter the pull request number. The Action resolves the live PR head SHA and current base SHA before TookEffect receives authority to act.

## What the Action does

1. Reads the pull request using the workflow's read-only `github-token`.
2. Resolves the exact head SHA, base branch, and current base SHA.
3. Builds a deterministic idempotency key bound to that exact immutable intent.
4. Calls TookEffect's production Verified Merge boundary at `https://tookeffect.com`.
5. If a request is still running or a response is lost, retries only the identical request with the same idempotency key.
6. Returns success only for a completed `APPLIED` verdict.
7. Writes a **Verified by TookEffect** GitHub Actions summary with the Effect ID and receipt information.

`NOT_APPLIED`, `AMBIGUOUS`, malformed responses, authorization errors, and verification timeouts fail the workflow.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `tookeffect-token` | Yes | — | TookEffect Agent API token. Use a GitHub secret. |
| `github-token` | Yes | — | Read-only token used only to resolve current GitHub PR/base state. `${{ github.token }}` is recommended. |
| `pull-number` | Yes | — | Pull request number. |
| `merge-method` | No | `squash` | `merge`, `squash`, or `rebase`. |
| `require-successful-checks` | No | `true` | Require TookEffect to enforce successful checks before mutation. |
| `timeout-seconds` | No | `90` | Wait for a final verdict for 15–300 seconds. |

## Outputs

| Output | Description |
| --- | --- |
| `effect-id` | Stable TookEffect Effect identifier. |
| `verdict` | `APPLIED`, `NOT_APPLIED`, or `AMBIGUOUS`. |
| `reason` | TookEffect's final reason when available. |
| `receipt-url` | Authenticated TookEffect Receipt API URL for the Effect. |
| `receipt-keys-url` | Public Ed25519/JWKS verification-key endpoint. |

Example of using an output after a successful step:

```yaml
- name: Print TookEffect Effect ID
  run: echo "Effect ${{ steps.tookeffect.outputs.effect-id }} was independently verified"
```

## Receipts and independent verification

Completed production Effects can issue Ed25519/JWS receipts. Receipt content is account-scoped and is read with the TookEffect token; the verification keys are public at:

```text
https://tookeffect.com/api/v1/receipt-keys
```

TookEffect also publishes a dependency-free receipt verifier at:

```text
https://tookeffect.com/verify-receipt.mjs
```

Cryptographic receipt verification proves integrity and origin of the evidence representation. The `APPLIED` verdict still depends on TookEffect's authoritative provider read-back.

## Security model

- This public repository is a thin client. TookEffect Core and provider credentials are not shipped in the Action.
- The TookEffect token is masked and is sent only to the fixed production origin `https://tookeffect.com`.
- The supplied GitHub token is sent only to `https://api.github.com` and needs read-only `contents` and `pull-requests` permissions.
- The merge itself is performed through the GitHub App authority already installed and authorized in TookEffect, not through the workflow token.
- The Action never converts a timeout, HTTP success alone, or missing response into an `APPLIED` verdict.

For workflows that can execute destructive actions, prefer an explicit `workflow_dispatch` or another deliberate authorization gate. Do not expose the TookEffect token to untrusted pull-request code.

## Why TookEffect

AI agents, pipelines, and APIs can report that an operation succeeded while the intended external state is different. TookEffect verifies the state that actually exists after the action and produces evidence for that result.

Learn more at [tookeffect.com](https://tookeffect.com).
