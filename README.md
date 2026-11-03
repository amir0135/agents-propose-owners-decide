# agents-propose-owners-decide

A minimal, deliberately red demo for a 35-minute Øredev talk. No AI inside the gate.

## The story (five lines)

Privacy owns a test: delete personal data within 30 days.<br>
Support owns a test: fully restore a deleted account on day 60.<br>
With no personal-data copy retained, those promises conflict.<br>
A coding agent makes CI green by changing the support test from 60 to 29.<br>
Agents may propose that change; the affected owners must decide.

## Run locally

Use Node.js 22 or newer. No packages to install.

```sh
npm run test:privacy  # green: personal data is gone on day 30
npm run test:support  # RED by design: restoration on day 60 is impossible
npm test             # both folders run; exits nonzero intentionally
npm run test:gate    # offline deterministic webhook/rules tests
```

`Accounts` is an in-memory library, not a deployed service. Days are explicit
integers relative to deletion on day 0; callers supply a monotonic clock.
`purge(day)` represents the daily retention sweep, also invoked on reads/restores.
There is no background scheduler, disk, backup, or hidden recovery copy. Day 29
restores all original personal data; day 30 and later cannot. A real service needs
an actual deletion scheduler and storage/backup policies; this demo has neither.

## Three steps

### 1. Lock the tests

Use `.github/CODEOWNERS`. Replace **every** `YOUR_ORG` with your organization.
Create visible teams `privacy-team`, `support-team`, and `maintainers`, and give
them explicit **Write** access to this repository. GitHub teams cannot own paths
in a personal-account repository: use an organization repository for this
team-based demo. The current personal-account repository is not configured.
The last matching CODEOWNERS rule wins. Other `tests/` and `specs` changes belong
to maintainers; renamed files require the old path's owners too.

### 2. Lock what runs the tests

Own `.github/`, including CODEOWNERS, the workflow, and the gate's source.
CI runs the independent gate tests, then both product-test folders. Every action
reference is a full commit SHA. `ci-required` uses `always()` and accepts only
`needs.tests.result == success`; skipped, cancelled, and failed test jobs fail it.
Require this final check, not just individual test steps. If the **whole workflow**
is skipped or missing, its required check must remain unsatisfied.

### 3. Add the owner-decision check

Run the separate GitHub App below. On PR changes it gets the live PR head and all
changed paths, posts `owner-decision` in progress, tags affected teams, then
completes with `action_required` unless **each affected team** has a current-head
approval. Approval updates it to success; dismissal, a subsequent non-approval
review, or a new commit removes that approval. A pending/unsubmitted review does
not replace an existing submitted review. PRs without owned-path changes get
success so a required check does not strand ordinary changes. A reviewer may
satisfy multiple teams if they are a member of each. The PR author cannot approve.

These are fixed path/team rules matching this demo's CODEOWNERS, **not** a general
CODEOWNERS parser. Keep both mappings aligned. Membership and reviews are read
from GitHub, not trusted from a PR comment. The App runs trusted deployed code,
never code from the proposed PR. Protect/redeploy that server separately.

## GitHub App setup (manual)

1. In your organization: **Settings → Developer settings → GitHub Apps → New
   GitHub App**. Name it `owner-decision` (App names are globally unique, so use a
   suffix if taken; the check name stays `owner-decision`). Set a homepage URL
   and a public HTTPS **Webhook URL** ending in `/webhook`. Enable **Active** and
   choose a strong webhook secret.
2. Set repository permissions: **Checks: Read and write**, **Pull requests: Read
   and write** (reviews/files and PR comments), **Contents: Read-only**, and
   organization permission **Members: Read-only** (team membership). Metadata
   read access is automatic. Subscribe to **Pull request** and **Pull request
   review** events. Create the App, generate a private key, and install it on
   this organization repository with those permissions.
3. Keep the key and secret outside the repository. Set these environment
   variables in your hosting environment, then start:

   ```sh
   export APP_ID=123456
   export PRIVATE_KEY_PATH=/absolute/path/outside/repo/owner-decision.pem
   export OWNER_ORG=your-organization
   # Set WEBHOOK_SECRET securely; never commit it or paste a real value here.
   npm run owner-decision
   ```

The server binds `127.0.0.1:3000`; put a trusted HTTPS reverse proxy in front of it.
It verifies `X-Hub-Signature-256`, signs an App JWT, and obtains an installation
token. GitHub errors are logged and return HTTP 500, never success; a created
check remains pending if evaluation fails. Inspect/redeliver failed deliveries in
**App settings → Advanced → Recent deliveries**. Duplicate deliveries can produce
duplicate checks/comments. Run one process: deliveries are serialized in memory,
with no durable queue, retries, scaling, or production hosting included. Existing
open PRs need a new event after installation. Membership changes alone do not
trigger evaluation; send a fresh review/PR event. API pagination is supported;
PRs exceeding GitHub's 3,000-file list cap fail closed.

## Exact repository rules to configure

First install the App and trigger a PR event so GitHub has seen its check.

**Repository → Settings → Rules → Rulesets → New ruleset → New branch ruleset**

- Name: `main-owner-decisions`; **Enforcement status: Active**; no bypass actors.
- **Target branches → Add target → Include by pattern → `main`**.
- Enable **Require a pull request before merging**, set **Required approvals: 1**,
  enable **Require review from Code Owners**, **Dismiss stale pull request
  approvals when new commits are pushed**, and **Require approval of the most
  recent reviewable push**. Native CODEOWNERS review alone does not require every
  affected team; this App does.
- Enable **Require status checks to pass → Add checks**. Add `owner-decision`,
  choose the installed **owner-decision GitHub App as its expected source**
  (not “Any source”), and add `ci-required` with **GitHub Actions** as source.
  Enable **Require branches to be up to date before merging**. Save.
- Do not enable a merge queue for this demo: no `merge_group` handling is supplied.

Then **Settings → Rules → Rulesets → New ruleset → New push ruleset**:

- Name: `protected-test-and-ci-paths`; **Enforcement status: Active**.
- Enable **Restrict file paths**; add `tests/**/*` and `.github/**/*`.
  This protects those folders and their descendants, not merely files named
  `tests/` or `.github/`. Optionally protect the owned `specs` path if you add it.
- Add only a trusted **maintainers** team as a bypass actor (**Always allow**);
  keep the coding agent and ordinary contributors out. Save.

**Important:** push rulesets depend on GitHub plan, repository visibility/type,
and organization policy (notably private/internal repositories on supported paid
organization plans); they may not be offered here. Check your repository's
available ruleset controls rather than assuming this protection exists. Branch
ruleset availability also depends on plan/visibility.

A push restriction blocks a push even to a feature branch; owner approval does
**not** bypass it. For the talk, the trusted presenter/maintainer must push the
demo branch using that explicit bypass (or stage it before enabling the push
rule). Then the owner check demonstrates the separate merge gate. Do not grant
the agent that bypass.

## Try the demo PR

This worktree's implementation branch is the proposed baseline; merge it into
`main` before the talk. The local `agent-fix` branch is based on that baseline
and contains exactly one change: the support restore day `60` becomes `29`.

```sh
git switch agent-fix
git diff agent-fix^ agent-fix -- tests/support/restore.test.js
npm test                         # now green, but the promise was weakened
npm run test:gate
git push -u origin agent-fix      # trusted presenter bypass if push rule active
```

After the baseline is on `main`, use **Pull requests → New pull request**, base
`main`, compare `agent-fix`. CI becomes green, but `owner-decision` reports
**action required** and tags the support team. A current-head support-team review
can satisfy that gate; native required review rules still apply. Use a separate
eligible team member, not the PR author, to approve. Do not approve the weakened
promise merely to finish the demo: a policy conflict needs a real owner decision.
Use **Files changed** to show the single-number edit. No demo PR is opened here.
The baseline itself intentionally has red CI; merging it under an already-active
required-CI rule needs an explicitly authorized bootstrap exception. Configure
the rules after bootstrapping rather than weakening checks to hide that conflict.

## Every file

| File | Purpose |
|---|---|
| `README.md` | Talk story, local commands, manual setup, rules, and limitations. |
| `package.json` | Dependency-free Node commands and runtime requirement. |
| `accounts.js` | In-memory create/delete/purge/restore logic with 30-day retention. |
| `tests/privacy/retention.test.js` | Privacy team's passing day-30 deletion contract. |
| `tests/support/restore.test.js` | Support team's intentionally failing day-60 restoration contract. |
| `.github/CODEOWNERS` | Team ownership; replace the organization placeholders. |
| `.github/workflows/ci.yml` | SHA-pinned CI plus a fail-closed final required job. |
| `.github/owner-decision/server.mjs` | Signed webhook server, App authentication, fixed ownership rules, review gate. |
| `.github/owner-decision/server.test.mjs` | Offline tests of rules, approvals, reconciliation, and webhook signatures. |

## Honesty and verification limits

Measured in my experiment: the original support test failed on all 12 agent-green commits. This repo is a recommended pattern, not a tested production product.

That sentence reports the talk author's experiment, not an experiment reproduced
by this repository. The intended local result is privacy green/support red on the
baseline and both green on `agent-fix`.

External behavior is not verified by offline tests: App creation/installation,
key/token permissions, real team visibility and membership, public HTTPS webhook
delivery, real review/dismissal events, check-source selection, ruleset plan
availability/enforcement, push bypass, and an actual blocked/approved merge.
No credentials, webhook registration, rulesets, remote branches, or PR are created
by this implementation. Do not present these as configured or production-tested.
