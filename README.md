<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tookeffect/tookeffect-action/75997e76ec9aba81f840c558098830590ed349df/assets/brand/tookeffect-white.svg">
  <img src="https://raw.githubusercontent.com/tookeffect/tookeffect-action/75997e76ec9aba81f840c558098830590ed349df/assets/brand/tookeffect-black.svg" alt="TookEffect" width="194" height="24">
</picture>

# TookEffect Verified Merge

[![CI](https://github.com/tookeffect/tookeffect-action/actions/workflows/ci.yml/badge.svg)](https://github.com/tookeffect/tookeffect-action/actions/workflows/ci.yml)

**Merge a pull request and independently verify that the expected change reached its destination.**

TookEffect Verified Merge is a GitHub Action for one specific job: executing an exact pull request merge through [TookEffect](https://tookeffect.com), then checking GitHub's resulting state and returning evidence. A successful API response alone is not proof that the expected effect occurred.

**This Action performs the merge.** It requires an open pull request and uses the TookEffect GitHub App's authorized access. It is separate from installing that app and from observing a merge performed elsewhere.

## Understand the result

The human-readable status matches TookEffect's product language. The `verdict` output keeps the existing API values so workflows remain compatible.

| Status | API verdict | Meaning | Action result |
| --- | --- | --- | --- |
| **Verified** | `APPLIED` | Authoritative GitHub read-back proves the requested merge on the destination branch. | Success |
| **Not applied** | `NOT_APPLIED` | Authoritative evidence establishes that the requested effect did not occur. | Failure |
| **Needs review** | `AMBIGUOUS` | Available evidence cannot safely establish whether the requested effect occurred. | Failure |

**Needs review does not mean the merge definitely failed.** Investigate the Effect in TookEffect before taking further action. An authorization error, missing response, or timeout is not a verification result and never counts as success.

[Open TookEffect](https://tookeffect.com) to configure the integration and inspect its Evidence and Signed Receipt.

## Quick start

### 1. Configure TookEffect for the repository

In the same TookEffect workspace:

1. Install and authorize the TookEffect GitHub App for the exact repository you want to merge into.
2. Configure its GitHub connection and a matching **Verified Target** for that repository. This Action sends the repository owner and name; TookEffect must be able to resolve one matching target safely. Installing the app alone is not sufficient.
3. Create or select an **Agent** authorized to execute `github.merge_pull_request` on that target under your workspace's rules.
4. Create an Agent API token with the required `effects:write` scope. Confirm that the workspace's current plan or trial permits the operation.

If your rules require approval, resolve it in TookEffect before expecting the workflow to complete. This Action does not bypass approval, target access, or plan limits.

### 2. Add the token as a repository secret

Create a GitHub Actions secret named:

```text
TOOKEFFECT_TOKEN
```

Store the TookEffect Agent API token in that secret. Never commit it to the repository.

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

Run the workflow from the GitHub **Actions** tab and enter the open pull request number. The Action resolves the live PR head SHA and current base SHA before TookEffect receives authority to act. The first run performs a real merge, so choose a pull request you intend to merge.

### 4. Read the result

Open the workflow's step summary. It displays **Verified**, **Not applied**, or **Needs review**, followed by the unchanged API verdict, Effect ID, available reason, and receipt links.

Only `APPLIED` passes the step. `NOT_APPLIED`, `AMBIGUOUS`, malformed responses, authorization errors, and timeouts fail it. Open the corresponding Effect in TookEffect to inspect its Evidence and Signed Receipt.

## What the Action does

1. Reads the pull request using the workflow's read-only `github-token`.
2. Resolves the exact head SHA, destination branch, and current base SHA.
3. Builds a deterministic idempotency key bound to that exact intent.
4. Calls TookEffect's production Verified Merge endpoint at `https://tookeffect.com`.
5. If a request is still running or a response is lost, retries only the identical request with the same idempotency key within the configured timeout.
6. Returns success only for an `APPLIED` final verdict.
7. Writes a result-specific GitHub Actions summary with the Effect ID and receipt information.

TookEffect performs the authorized merge through its GitHub App and reads GitHub back to determine the result. The Action does not independently compute a verdict or sign a receipt.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `tookeffect-token` | Yes | — | TookEffect Agent API token. Use a GitHub secret. |
| `github-token` | Yes | — | Read-only token used only to resolve current GitHub PR/base state. `${{ github.token }}` is recommended. |
| `pull-number` | Yes | — | Open pull request number to merge and verify. |
| `merge-method` | No | `squash` | `merge`, `squash`, or `rebase`. |
| `require-successful-checks` | No | `true` | Require TookEffect to enforce successful checks before the merge. |
| `timeout-seconds` | No | `90` | Wait for a final verdict for 15–300 seconds. |

## Outputs

| Output | Description |
| --- | --- |
| `effect-id` | Stable TookEffect Effect identifier. |
| `verdict` | Canonical API value: `APPLIED`, `NOT_APPLIED`, or `AMBIGUOUS`. Human-readable labels do not replace these values. |
| `reason` | TookEffect's final reason when available. |
| `receipt-url` | Authenticated TookEffect Receipt API URL for the Effect. |
| `receipt-keys-url` | Public Ed25519/JWKS verification-key endpoint. |

Outputs are written when the Action receives a recognized final verdict. A request that fails before that point may not produce outputs.

Example of using an output after a successful step:

```yaml
- name: Print TookEffect Effect ID
  env:
    TOOKEFFECT_EFFECT_ID: ${{ steps.tookeffect.outputs.effect-id }}
  run: printf 'Effect %s was independently verified\n' "$TOOKEFFECT_EFFECT_ID"
```

## If the workflow stops

| Situation | What to check |
| --- | --- |
| Missing or unauthorized Verified Target | Confirm the repository, target, GitHub installation, Agent authorization, and token all belong to the intended workspace. If multiple targets match, resolve that ambiguity in TookEffect. |
| Approval required | Review the pending approval in TookEffect. The Action does not approve requests on your behalf. |
| Plan or usage limit | Check the workspace's current plan, trial eligibility, and usage. Repeating the workflow does not remove a limit. |
| Not applied | Read the final reason and Evidence before deciding whether a new authorized attempt is appropriate. |
| Needs review or timeout | Inspect the Effect and actual repository state. Do not treat the lack of confirmation as proof that nothing happened. |

Retries within one run preserve the exact intent and idempotency key. A new workflow run reads the PR and base branch again; if they have changed, it represents a different intent. Do not blindly rerun after an uncertain result.

## Receipts and independent verification

Completed production Effects can issue Ed25519/JWS receipts. Receipt content is account-scoped and is read with the TookEffect token; a receipt API link is not a public share link. The verification keys are public at:

```text
https://tookeffect.com/api/v1/receipt-keys
```

TookEffect also publishes a dependency-free receipt verifier at:

```text
https://tookeffect.com/verify-receipt.mjs
```

Cryptographic receipt verification proves the integrity and origin of the evidence representation. The `APPLIED` verdict depends on TookEffect's authoritative provider read-back. This Action provides receipt links; it does not itself verify a receipt signature.

## Security model

- This public repository is a thin client. TookEffect Core and provider credentials are not shipped in the Action.
- The TookEffect token is masked and sent only to the fixed production origin `https://tookeffect.com`.
- The supplied GitHub token is sent only to `https://api.github.com` and needs read-only `contents` and `pull-requests` permissions.
- The merge itself uses the GitHub App authority installed and authorized in TookEffect, not the workflow token.
- The Action never converts a timeout, HTTP success alone, or missing response into an `APPLIED` verdict.

Use an explicit `workflow_dispatch` or another deliberate authorization gate for merge workflows. Do not expose the TookEffect token to untrusted pull-request code.

## About this integration

This repository publishes the **TookEffect Verified Merge GitHub Action**. Its Marketplace badge uses GitHub's supported icon and color settings; the TookEffect logo above identifies the product behind the integration.

Learn more at [tookeffect.com](https://tookeffect.com).
