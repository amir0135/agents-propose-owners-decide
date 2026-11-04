# agents-propose-owners-decide

A minimal, deliberately red demo for a 35-minute Øredev talk. No AI inside the gate.

## The story (five lines)

Privacy owns a test: delete personal data within 30 days.<br>
Support owns a test: fully restore a deleted account on day 60.<br>
With no personal-data copy retained, those promises conflict.<br>
A coding agent makes CI green by changing the support test from 60 to 29.<br>
Agents may propose that change; the affected owners must decide.

## Try the interactive demo

Install **Node.js 22+** and Git. No dependencies, accounts, credentials, or
`npm install` are needed. Use this integrated walkthrough branch; the default
`main` page has not been updated because publication requires an authorized
review/bootstrap decision under its active no-bypass rules:

```sh
git clone --branch interactive-talk https://github.com/amir0135/agents-propose-owners-decide.git
cd agents-propose-owners-decide
npm run demo         # guided terminal: choose, test, and try owner approvals
```

Press Enter to see the conflict. Choose **1** to try `60 -> 29` in a temporary
copy, or **2** to keep the original contract. Try **n** (non-owner), **s** (stale
owner), then **o** (current-head owner). Only the last simulated approval counts.
Use **q**, Ctrl-C, or end of input to cancel. Invalid choices prompt again.
Nothing is edited in your checkout; temporary files are removed.

**Owner decisions are simulated**, using the same plain approval rules as the
gate. This terminal command makes no GitHub API calls and does not demonstrate
configured live merge enforcement. Green CI is not owner consent.

### Optional checks and HTTP walkthrough

```sh
npm test             # EXPECTED exit 1: 4 pass, day-60 support fails
npm run test:privacy  # 4 pass
npm run demo:gate    # local narrated walkthrough; exits 0
npm run test:gate    # all 39 terminal/gate/client/HTTP/CI regressions pass
```

`demo:gate` starts the actual webhook on an ephemeral loopback HTTP port, sends
signed PR/review payloads, and prints `in_progress -> action_required`, rejected
non-owner/stale approvals, current-owner `success`, and dismissal. It also runs
the product tests in a temporary copy, then changes only `60` to `29` there and
shows all five passing. It removes its temporary files and closes the server;
your checkout is unchanged. **GitHub API responses, accounts, teams, and review
records are simulated. No live App, network tunnel, credentials, rules, or merge
enforcement is exercised.** The command reuses the real HTTP regression test,
not a second implementation of the gate.

To see the original published one-line branch contrast:

```sh
git switch --detach origin/agent-fix
npm test             # 5 pass; the support promise was weakened
git diff origin/main origin/agent-fix -- tests/support/restore.test.js
git switch interactive-talk
npm run demo:gate    # back on the walkthrough branch
```

The detached checkout is for inspection only; do not commit there. The original
`agent-fix` does not contain `demo:gate`; switch back before running it. The
original remote `main` and `agent-fix` are unchanged by this walkthrough update.
No separately downloaded bundle or unpublished artifact is needed.

**Partially configured, not the complete owner-decision barrier:** this is now a
public personal-account repository. Native review and CI rules are active on
`main`; the separate `owner-decision` App gate, real team ownership, and push-path
restrictions are not configured. Do not present the full merge-blocking story as
verified end to end.

## Verified live setup (2026-11-03)

The repository is public (anonymous HTTP access verified).
[Branch ruleset `main-owner-decisions`](https://github.com/amir0135/agents-propose-owners-decide/rules/26484745)
is active on `refs/heads/main`, with no bypass actors. It requires one approving
review, dismisses stale approvals on push, requires Code Owner review and approval
of the last reviewable push, and requires strict/up-to-date `ci-required` from
GitHub Actions integration `15368`. The ruleset configuration was read back from
GitHub; an actual rejected push or blocked/approved merge was not exercised.

`owner-decision` is **not** a required check yet, and no App source is bound for
it. No App credentials or hosted HTTPS endpoint have been identified/configured.
No organization transfer or real teams have been created; CODEOWNERS still has
`YOUR_ORG` placeholders, so enabling native Code Owner review does not establish
the intended team approvals. No push-path ruleset is configured. The steps below
describe the remaining target setup, not controls already verified as enforcing
the complete demo.

## Run locally

Use Node.js 22 or newer. No packages to install.

```sh
npm run test:privacy  # green: personal data is gone on day 30
npm run test:support  # RED by design: restoration on day 60 is impossible
npm test             # both folders run; exits nonzero intentionally
npm run test:gate    # offline rules, real local HTTP, GitHub client, and CI-guard tests
```

`Accounts` is an in-memory library, not a deployed service. Days are explicit
integers relative to deletion on day 0; callers supply a monotonic clock.
`purge(day)` represents the daily retention sweep, also invoked on reads/restores.
There is no background scheduler, disk, backup, or hidden recovery copy. Day 29
restores all original personal data; day 30 and later cannot. A real service needs
an actual deletion scheduler and storage/backup policies; this demo has neither.

### What the executable tests establish

`npm run test:privacy` covers exact day-29/day-30 boundaries, a later deletion
date, repeated delete without resetting retention, a second deletion after
restoration, independent accounts, complete nested-data restoration, defensive
copies, missing/duplicate accounts, and idempotent purge. Inputs must follow the
documented integer-day/monotonic-clock convention; this is not an input-validation
or persistent-storage service.

`npm run test:gate` exercises owned, deleted, and renamed paths; all affected
teams; non-owner and author rejection; stale, dismissed, changed, commented,
pending, and renewed reviews; and closed/unowned PRs. It tests pagination of
files/reviews/members beyond 100 entries, incomplete file lists including
GitHub's 3,000-file cap, and errors at every API stage. App JWT signatures are
verified using an ephemeral local RSA key; token/API HTTP, network, and malformed
JSON failures are simulated. No real credentials or outbound GitHub requests
are used by these tests. The CLI must refuse startup when any required App
configuration value is absent.

A real loopback HTTP server tests signatures, wrong routes, oversized bodies,
ignored events, malformed JSON, approval/dismissal deliveries, error responses,
and recovery after failure. The server is closed by the test. An additional
concurrent-delivery test exercises the single-process queue. The test reads
`ci.yml`, checks every action pin, and executes its actual shell guard with
`success`, `failure`, `cancelled`, `skipped`, empty, and unexpected results.
Only `success` passes. A temporary fixture changes package scripts to `exit 0`
and proves that the protected workflow's direct commands still execute failing
tests. Shared-head regressions cover alternate-base PRs, ambiguous `main` PRs,
and re-evaluation after a duplicate closes. Tests do not simulate the GitHub
Actions scheduler or prove that deployed repository controls cannot be bypassed.

To reproduce the contrasting product result, run `npm test` on `main` (only
support fails), then on `agent-fix` (all pass). Run `npm run test:gate` on both.
Do not treat the intentional red baseline as a passing suite or turn the day-60
assertion into an expected failure; that would hide the talk's conflict.

## Three steps

### 1. Lock the tests

Use `.github/CODEOWNERS`. Replace **every** `YOUR_ORG` with your organization.
Create visible teams `privacy-team`, `support-team`, and `maintainers`, and give
them explicit **Write** access to this repository. GitHub teams cannot own paths
in a personal-account repository: use an organization repository for this
team-based demo. The current personal-account repository has no real team mapping.
The last matching CODEOWNERS rule wins. Other `tests/` and `specs` changes belong
to maintainers; renamed files require the old path's owners too.

### 2. Lock what runs the tests

Own `.github/`, including CODEOWNERS, the workflow, and the gate's source.
CI runs the independent gate tests, then both product-test folders, using fixed
`node --test` commands in the protected workflow. It does not execute mutable
`package.json` scripts or load Node options from an unowned config file. Every
action reference is a full commit SHA. `ci-required` uses `always()` and accepts only
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

The demo enforces **only PRs targeting `main`**. Check runs belong to commits,
not PRs: for every supported event the server finds open `main` PRs sharing that
head SHA and evaluates their live data, never an alternate-base PR's diff or
reviews. No matching `main` PR means no check is published. Multiple matching
`main` PRs fail closed with `action_required`; close duplicates or use distinct
head commits. Closing or retargeting a duplicate triggers re-evaluation of the
remaining `main` PR. This deliberately conservative rule avoids publishing one
PR's success over another PR's requirements. It is not a multi-base policy engine.

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
If a delivery fails before a new check is created, a previous successful check
may still be visible. These tests do not establish atomic revocation of a
previous decision across API outages or lost deliveries. Monitor deliveries
and do not rely on this demo as a production authorization boundary.

## Exact repository rules to configure

The branch ruleset above already exists with native review and `ci-required`.
The following is the complete target configuration: edit that existing ruleset
rather than creating a duplicate. First install the App and trigger a PR event
so GitHub has seen its check, then add its source-restricted `owner-decision`
requirement. That App requirement is not currently enabled.

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
organization plans). Public visibility made branch rulesets available here; it
does not supply the private/internal organization push-ruleset feature. No push
ruleset is configured for this public personal repository. Upgrading a
personal-account plan alone does not establish organization-team ownership or
guarantee push-ruleset availability. Check your target repository's controls
rather than assuming protection exists.

A push restriction blocks a push even to a feature branch; owner approval does
**not** bypass it. For the talk, the trusted presenter/maintainer must push the
demo branch using that explicit bypass (or stage it before enabling the push
rule). Then the owner check demonstrates the separate merge gate. Do not grant
the agent that bypass.

## Try the demo PR

The baseline is published on `main` in
[amir0135/agents-propose-owners-decide](https://github.com/amir0135/agents-propose-owners-decide).
The published `agent-fix` branch is based on that baseline and contains exactly
one change: the support restore day `60` becomes `29`.

```sh
git fetch origin
git switch agent-fix             # or: git switch --track origin/agent-fix
git diff origin/main agent-fix -- tests/support/restore.test.js
npm test                         # now green, but the promise was weakened
npm run test:gate
```

After configuring the App, owners, and rules above, use **Pull requests → New
pull request**, base `main`, compare `agent-fix`. CI becomes green, but `owner-decision` reports
**action required** and tags the support team. A current-head support-team review
can satisfy that gate; native required review rules still apply. Use a separate
eligible team member, not the PR author, to approve. Do not approve the weakened
promise merely to finish the demo: a policy conflict needs a real owner decision.
Use **Files changed** to show the single-number edit. No demo PR is opened here.
The baseline itself intentionally has red CI; it was published before configuring
required checks. Configure the rules after bootstrapping rather than weakening
checks to hide that conflict. Future pushes to protected paths need the trusted
presenter bypass described above.

## Adopt it for your own DevOps

**Licensing is unresolved:** no license is currently supplied. Public visibility
does not grant general permission to reuse, modify, or redistribute this code.
Obtain the owner's permission or wait for an explicit license before downstream
DevOps reuse. The checklist below is technical guidance, not a license grant.

Fork or import into a repository you administer; keep the intentional conflict
only in a disposable demo. For an existing product, keep its actual tests and
adapt the small fixed path/team map rather than copying these conflicting
requirements. `demo:gate` and offline tests require no GitHub setup.

1. Choose an organization repository and create visible `privacy-team`,
   `support-team`, and `maintainers` teams with explicit Write access. Replace
   `YOUR_ORG` in CODEOWNERS and set `OWNER_ORG` to the same organization.
   Keep CODEOWNERS and `ownersForFiles` aligned; change the hard-coded `main`
   target deliberately if your protected branch has a different name.
2. Deploy trusted baseline App code behind HTTPS using the manual setup above.
   Grant only Checks read/write, Pull requests read/write, Contents read,
   organization Members read, and automatic Metadata read. Store the App key
   and webhook secret outside Git; subscribe to PR and PR-review events.
   Never deploy the proposed PR's server as the trusted reviewer.
3. Configure the exact branch rules above in your own repository: native
   Code Owner/current-push review, strict `ci-required` from GitHub Actions,
   and `owner-decision` from the installed App, no untrusted bypass. Keep the
   fixed test commands and immutable action pins in protected `.github/`.
   Add push-path protection only where your plan/repository supports it;
   provision a trusted presenter bypass before demonstrating protected edits.
4. Verify live before relying on it: an owned-path PR must be blocked before
   approval; non-owner and old-head approval must not unlock it; current-head
   owner approval must satisfy the App; new commits and dismissal must block
   again. Exercise all affected teams, rename/delete, alternate-base/shared-head
   PRs, and failed deliveries. Confirm missing/skipped/failing CI cannot merge,
   another check producer cannot satisfy the App-source requirement, and an
   ordinary unowned-path PR can proceed. Verify push restrictions separately.

These are **acceptance criteria, not completed live tests**. Inspect failed
webhook deliveries and test restart/outage behavior; a failed delivery can leave
an older success visible. This single-process example lacks durable delivery
processing and is not certified as a production policy boundary. Keep an
independently enforced native review requirement; decide deployment readiness
only after your own review of hosting, failure handling, and repository policy.

## Every file

| File | Purpose |
|---|---|
| `README.md` | Talk story, local commands, manual setup, rules, and limitations. |
| `package.json` | Dependency-free commands: interactive `demo`, HTTP `demo:gate`, tests, and App server. |
| `.github/talk.mjs` | Guided terminal choices, disposable red/green test copy, and explicitly simulated owner decisions. |
| `accounts.js` | In-memory create/delete/purge/restore logic with 30-day retention. |
| `tests/privacy/retention.test.js` | Passing day-30 contract plus retention, restoration, and copy-isolation regressions. |
| `tests/support/restore.test.js` | Support team's intentionally failing day-60 restoration contract. |
| `.github/CODEOWNERS` | Team ownership; replace the organization placeholders. |
| `.github/workflows/ci.yml` | SHA-pinned CI plus a fail-closed final required job. |
| `.github/owner-decision/server.mjs` | Signed webhook server, App authentication, fixed ownership rules, review gate. |
| `.github/owner-decision/server.test.mjs` | Rules, reviews, pagination/failures, App JWT, narrated local HTTP/product demo, and executable CI-guard tests. |

## Honesty and verification limits

Measured in my experiment: the original support test failed on all 12 agent-green commits. This repo is a recommended pattern, not a tested production product.

That sentence reports the talk author's experiment, not an experiment reproduced
by this repository. The intended local result is privacy green/support red on the
baseline and both green on `agent-fix`.

The original published baseline and demo were also run on GitHub Actions:
[baseline run](https://github.com/amir0135/agents-propose-owners-decide/actions/runs/41678460492)
failed at the support test and `ci-required`, while
[demo run](https://github.com/amir0135/agents-propose-owners-decide/actions/runs/41678477035)
passed both jobs. Those historical runs do not establish that later revisions,
skipped-workflow behavior, or required-check enforcement were tested on GitHub.
The pinned v4 actions emitted upstream Node-20-runtime deprecation warnings;
they did execute successfully, but their continued runner compatibility is not
guaranteed.

Public visibility and the native branch ruleset configuration described above
were verified live. The former private-repository ruleset HTTP 403 restriction
no longer applies after publication. This does not verify end-to-end enforcement.

Still unverified or incomplete: App creation/installation and token permissions,
real organization teams/membership, hosted public HTTPS delivery, real review and
dismissal events, source-restricted `owner-decision`, push-path ruleset
availability/enforcement, bypass behavior, and an actual blocked/approved merge.
App installation status could not be established using the available user token
(the App endpoint requires App JWT authentication), so it remains unverified,
not proven absent. The baseline and one-line demo branches are published remotely.
No credentials, webhook registration, organization transfer, teams, push ruleset,
or PR were created. Do not present those missing controls as configured or
production-tested.
Passing these executable checks is evidence for the stated demo behavior, not a
claim that this server is safe to deploy as a production policy enforcement
service. Real deployment requires separate review and end-to-end validation of
the App, hosting, delivery/failure handling, and repository controls above.
