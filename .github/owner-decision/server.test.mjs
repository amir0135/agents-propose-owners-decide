import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { approvedTeams, ownersForFiles, reconcile, webhook } from "./server.mjs";

test("owned paths include renamed-away paths and do not match lookalikes", () => {
  assert.deepEqual(ownersForFiles([
    { filename: "docs/test.js", previous_filename: "tests/support/restore.test.js" },
    { filename: "tests/privacy/new.js" }, { filename: ".github/workflows/ci.yml" },
    { filename: "specs/rule.md" }, { filename: "tests/misc.js" },
  ], "demo"), ["demo/maintainers", "demo/privacy-team", "demo/support-team"]);
  assert.deepEqual(ownersForFiles([{ filename: "specstuff/a" }, { filename: "accounts.js" }], "demo"), []);
});

test("only latest non-pending, current-head approvals from team members count", async () => {
  const review = (login, state, commit_id = "head") => ({ user: { login }, state, commit_id });
  const teams = ["demo/privacy-team", "demo/support-team"];
  const member = async (team, login) => team.endsWith(login);
  assert.deepEqual(await approvedTeams([
    review("privacy-team", "APPROVED"), review("support-team", "APPROVED", "old"),
    review("outsider", "APPROVED"),
  ], teams, "head", member), ["demo/privacy-team"]);
  for (const state of ["DISMISSED", "CHANGES_REQUESTED", "COMMENTED"]) {
    assert.deepEqual(await approvedTeams([
      review("privacy-team", "APPROVED"), review("privacy-team", state),
    ], teams, "head", member), []);
  }
  assert.deepEqual(await approvedTeams([
    review("privacy-team", "APPROVED"), review("privacy-team", "PENDING"),
    review("support-team", "APPROVED"),
  ], teams, "head", member), teams);
});

test("reconciliation starts pending, tags owners, and fails closed or approves", async () => {
  for (const approved of [false, true]) {
    const writes = [];
    const api = async (path, method = "GET", body) => {
      if (method !== "GET") { writes.push({ path, body }); return { id: 7 }; }
      if (path.endsWith("/pulls/1")) return {
        state: "open", changed_files: 1, head: { sha: "head" }, user: { login: "author" },
      };
      if (path.includes("/files?")) return [{ filename: "tests/support/restore.test.js" }];
      if (path.includes("/reviews?")) return approved ?
        [{ user: { login: "sam" }, state: "APPROVED", commit_id: "head" }] : [];
      if (path.includes("/members?")) return [{ login: "sam" }];
      throw new Error(`Unexpected API request: ${path}`);
    };
    await reconcile({ repository: { full_name: "demo/repo" }, pull_request: { number: 1 },
      action: "opened" }, { org: "demo" }, api);
    assert.equal(writes[0].body.status, "in_progress");
    assert.match(writes[1].body.body, /@demo\/support-team/);
    assert.equal(writes[2].body.conclusion, approved ? "success" : "action_required");
  }
});

test("no owned changes pass; incomplete file lists never produce success", async () => {
  for (const changedFiles of [1, 2]) {
    const writes = [];
    const api = async (path, method = "GET", body) => {
      if (method !== "GET") { writes.push(body); return { id: 8 }; }
      if (path.endsWith("/pulls/1")) return {
        state: "open", changed_files: changedFiles, head: { sha: "head" },
      };
      if (path.includes("/files?")) return [{ filename: "accounts.js" }];
      if (path.includes("/reviews?")) return [];
      throw new Error(`Unexpected API request: ${path}`);
    };
    const run = reconcile({ repository: { full_name: "demo/repo" },
      pull_request: { number: 1 }, action: "opened" }, { org: "demo" }, api);
    if (changedFiles === 1) {
      await run;
      assert.equal(writes.at(-1).conclusion, "success");
      assert.equal(writes.length, 2);
    } else {
      await assert.rejects(run, /Incomplete PR file list/);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].status, "in_progress");
    }
  }
});

test("signed review event reaches reconciliation and succeeds without a comment", async () => {
  const secret = "local-test-secret";
  const payload = {
    action: "submitted", installation: { id: 42 },
    repository: { full_name: "demo/repo" }, pull_request: { number: 1 },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([body]);
  req.method = "POST";
  req.url = "/webhook";
  req.headers = {
    "x-github-event": "pull_request_review",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
  const writes = [];
  const api = async (path, method = "GET", value) => {
    if (method !== "GET") { writes.push(value); return { id: 9 }; }
    if (path.endsWith("/pulls/1")) return {
      state: "open", changed_files: 1, head: { sha: "head" }, user: { login: "author" },
    };
    if (path.includes("/files?")) return [{ filename: "tests/support/restore.test.js" }];
    if (path.includes("/reviews?")) return [
      { user: { login: "sam" }, state: "APPROVED", commit_id: "head" },
    ];
    if (path.includes("/members?")) return [{ login: "sam" }];
    throw new Error(`Unexpected API request: ${path}`);
  };
  const res = { writeHead(status) { this.status = status; return this; }, end() {} };
  await webhook({ secret, org: "demo" }, async installation => {
    assert.equal(installation, 42);
    return api;
  })(req, res);
  assert.equal(res.status, 200);
  assert.equal(writes.length, 2);
  assert.equal(writes.at(-1).conclusion, "success");
});

test("webhook rejects unsigned payloads and accepts signed irrelevant events", async () => {
  const secret = "local-test-secret";
  const body = Buffer.from('{"action":"ignored"}');
  for (const signed of [false, true]) {
    const req = Readable.from([body]);
    req.method = "POST";
    req.url = "/webhook";
    req.headers = { "x-github-event": "ping" };
    if (signed) req.headers["x-hub-signature-256"] =
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const res = { writeHead(status) { this.status = status; return this; }, end() {} };
    await webhook({ secret }, () => { throw new Error("Must not call GitHub"); })(req, res);
    assert.equal(res.status, signed ? 204 : 401);
  }
});
