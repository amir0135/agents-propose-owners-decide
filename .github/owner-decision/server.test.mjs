import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import { approvedTeams, githubClient, ownersForFiles, reconcile, webhook } from "./server.mjs";

test("interactive talk covers choices, invalid input, cancellation and leaves source untouched", () => {
  const file = new URL("../../tests/support/restore.test.js", import.meta.url);
  const original = readFileSync(file, "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const [input, expected] of [
    ["\n1\nn\ns\no\n", /SIMULATED owner-decision: success/],
    ["\n2\n", /Contract kept/],
    ["bad\n\nbad\n1\nbad\no\n", /SIMULATED owner-decision: success/],
    ["q\n", /Demo cancelled/],
    ["\nq\n", /Demo cancelled/],
    ["\n1\nq\n", /Demo cancelled/],
    ["", /Demo cancelled/],
    ["\n", /Demo cancelled/],
    ["\n1\n", /Demo cancelled/],
  ]) {
    const actual = spawnSync(process.execPath, [new URL("../talk.mjs", import.meta.url).pathname], {
      input, env, encoding: "utf8", timeout: 10000,
    });

    assert.equal(actual.status, 0, actual.stdout + actual.stderr);
    assert.match(actual.stdout, expected);
    assert.match(actual.stdout, /Checkout unchanged/);
    if (input.includes("n\ns\n")) {
      assert.equal(actual.stdout.match(/That approval does not count/g).length, 2);
    }
    assert.equal(readFileSync(file, "utf8"), original);
  }
});

test("interactive talk cancels cleanly on Ctrl-C", async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [new URL("../talk.mjs", import.meta.url).pathname], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let interrupted = false;
  const result = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on("data", chunk => {
    output += chunk;
    if (!interrupted && output.includes("Press Enter")) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const { code, signal } = await result;
    assert.equal(code, 0, output);
    assert.equal(signal, null);
    assert.match(output, /Demo cancelled/);
    assert.match(output, /Checkout unchanged/);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
  }
});

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
    const { api, writes } = fixture({ reviews: approved ? [review("sam")] : [] });
    await reconcile({ repository: { full_name: "demo/repo" }, pull_request: { number: 1 },
      action: "opened" }, { org: "demo" }, api);
    assert.equal(writes[0].body.status, "in_progress");
    assert.match(writes[1].body.body, /@demo\/support-team/);
    assert.equal(writes[2].body.conclusion, approved ? "success" : "action_required");
  }
});

test("no owned changes pass; incomplete file lists never produce success", async () => {
  for (const changedFiles of [1, 2]) {
    const { api, writes } = fixture({ changedFiles, files: [{ filename: "accounts.js" }] });
    const run = reconcile({ repository: { full_name: "demo/repo" },
      pull_request: { number: 1 }, action: "opened" }, { org: "demo" }, api);
    if (changedFiles === 1) {
      await run;
      assert.equal(writes.at(-1).body.conclusion, "success");
      assert.equal(writes.length, 2);
    } else {
      await assert.rejects(run, /Incomplete PR file list/);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body.status, "in_progress");
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
  const { api, writes } = fixture({ reviews: [review("sam")] });
  const res = { writeHead(status) { this.status = status; return this; }, end() {} };
  await webhook({ secret, org: "demo" }, async installation => {
    assert.equal(installation, 42);
    return api;
  })(req, res);
  assert.equal(res.status, 200);
  assert.equal(writes.length, 2);
  assert.equal(writes.at(-1).body.conclusion, "success");
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

const payload = {
  action: "opened", installation: { id: 42 },
  repository: { full_name: "demo/repo" }, pull_request: { number: 1 },
};
const review = (login, state = "APPROVED", sha = "head") =>
  ({ user: { login }, state, commit_id: sha });

function fixture(options = {}) {
  const files = options.files ?? [{ filename: "tests/support/restore.test.js" }];
  const pr = {
    number: 1, state: options.state ?? "open", changed_files: options.changedFiles ?? files.length,
    head: { sha: "head" }, user: { login: "author" }, base: { ref: options.base ?? "main" },
  };
  const writes = [];
  const calls = [];
  const api = async (path, method = "GET", body) => {
    calls.push(path);
    if (options.fail?.(path, method)) throw new Error("Simulated GitHub failure");
    if (method !== "GET") { writes.push({ path, body }); return { id: 10 }; }
    if (/\/pulls\/\d+$/.test(path)) {
      return options.pullRequests?.[path.split("/").at(-1)] ?? pr;
    }
    const url = new URL(path, "https://api.github.com");
    const page = Number(url.searchParams.get("page"));
    let items;
    if (url.pathname.endsWith("/pulls")) {
      items = options.openPrs ?? (pr.state === "open" && pr.base.ref === "main" ? [pr] : []);
    } else if (url.pathname.endsWith("/files")) items = files;
    else if (url.pathname.endsWith("/reviews")) items = options.reviews ?? [];
    else if (url.pathname.endsWith("/members")) {
      const slug = url.pathname.split("/").at(-2);
      items = options.members?.[slug] ?? [{ login: "sam" }];
    } else throw new Error(`Unexpected API request: ${path}`);
    return items.slice((page - 1) * 100, page * 100);
  };
  return { api, writes, calls };
}

for (const [label, reviews, expected] of [
  ["current approval", [review("sam")], "success"],
  ["author approval", [review("author")], "action_required"],
  ["outsider approval", [review("outsider")], "action_required"],
  ["stale approval", [review("sam", "APPROVED", "old-head")], "action_required"],
  ["dismissal", [review("sam"), review("sam", "DISMISSED")], "action_required"],
  ["changes requested", [review("sam"), review("sam", "CHANGES_REQUESTED")], "action_required"],
  ["comment after approval", [review("sam"), review("sam", "COMMENTED")], "action_required"],
  ["reapproval", [review("sam", "DISMISSED"), review("sam")], "success"],
  ["unsubmitted review", [review("sam"), review("sam", "PENDING")], "success"],
]) {
  test(`reconcile: ${label}`, async () => {
    const { api, writes } = fixture({
      reviews, members: { "support-team": [{ login: "sam" }, { login: "author" }] },
    });
    await reconcile({ ...payload, action: "submitted" }, { org: "demo" }, api);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].body.head_sha, "head");
    assert.equal(writes.at(-1).body.conclusion, expected);
  });
}

test("rename across teams, removed tests, and CI/spec changes require every affected team", async () => {
  const files = [
    { status: "renamed", filename: "tests/privacy/moved.js", previous_filename: "tests/support/old.js" },
    { status: "removed", filename: "tests/support/deleted.js" },
    { filename: ".github/workflows/ci.yml" }, { filename: "specs" },
  ];
  assert.deepEqual(ownersForFiles(files, "demo"),
    ["demo/maintainers", "demo/privacy-team", "demo/support-team"]);
  for (const complete of [false, true]) {
    const { api, writes } = fixture({
      files, reviews: [review("privacy"), review("support"), ...(complete ? [review("maintainer")] : [])],
      members: {
        "privacy-team": [{ login: "privacy" }], "support-team": [{ login: "support" }],
        maintainers: [{ login: "maintainer" }],
      },
    });
    await reconcile(payload, { org: "demo" }, api);
    for (const team of ["privacy-team", "support-team", "maintainers"]) {
      assert.ok(writes[1].body.body.includes(`@demo/${team}`));
    }
    assert.equal(writes.at(-1).body.conclusion, complete ? "success" : "action_required");
  }
});

test("files, reviews and team memberships paginate past the first 100 entries", async () => {
  const { api, writes, calls } = fixture({
    files: [...Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` })),
      { filename: "tests/support/restore.test.js" }],
    reviews: [...Array.from({ length: 100 }, () => review("sam", "CHANGES_REQUESTED")), review("sam")],
    members: { "support-team": [
      ...Array.from({ length: 100 }, (_, i) => ({ login: `other-${i}` })), { login: "sam" },
    ] },
  });
  await reconcile(payload, { org: "demo" }, api);
  for (const resource of ["files", "reviews", "members"]) {
    assert.ok(calls.some(path => path.includes(`/${resource}?per_page=100&page=2`)));
  }
  assert.equal(writes.at(-1).body.conclusion, "success");
});

test("GitHub's 3,000-file cap cannot silently approve a larger PR", async () => {
  const { api, writes, calls } = fixture({
    files: Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` })),
    changedFiles: 3001,
  });
  await assert.rejects(reconcile(payload, { org: "demo" }, api), /Incomplete PR file list/);
  assert.ok(calls.some(path => path.endsWith("/files?per_page=100&page=31")));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.status, "in_progress");
});

test("main PR lookup retains query filters and finds matching heads beyond page one", async () => {
  const { api, writes, calls } = fixture({
    openPrs: [
      ...Array.from({ length: 100 }, (_, i) => ({ number: i + 2, head: { sha: `other-${i}` } })),
      { number: 1, head: { sha: "head" } },
    ],
  });
  await reconcile(payload, { org: "demo" }, api);
  assert.ok(calls.includes("/repos/demo/repo/pulls?state=open&base=main&per_page=100&page=2"));
  assert.equal(writes.at(-1).body.conclusion, "action_required");
});

test("closed PRs do not create checks or comments", async () => {
  const { api, writes, calls } = fixture({ state: "closed" });
  await reconcile(payload, { org: "demo" }, api);
  assert.equal(calls.length, 2);
  assert.deepEqual(writes, []);
});

for (const stage of ["pulls/1", "pulls?", "check-runs", "files?", "reviews?", "members?", "comments", "check-runs/10"]) {
  test(`API failure at ${stage} cannot write a successful conclusion`, async () => {
    const { api, writes } = fixture({
      reviews: [review("sam")],
      fail: path => path.includes(stage),
    });
    await assert.rejects(reconcile(payload, { org: "demo" }, api), /Simulated GitHub failure/);
    assert.equal(writes.some(write => write.body.conclusion === "success"), false);
  });
}

test("GitHub client signs a valid JWT and surfaces token/API failures", async t => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const config = { appId: "123", privateKey };
  const requests = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.endsWith("/access_tokens") ? { token: "test-installation-token" } : { id: 10 });
  });
  const api = await githubClient(config)(42);
  await api("/repos/demo/repo/check-runs", "POST", { name: "owner-decision" });
  const jwt = requests[0].options.headers.Authorization.slice("Bearer ".length);
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const decoded = JSON.parse(Buffer.from(claims, "base64url"));
  const now = Math.floor(Date.now() / 1000);
  assert.equal(decoded.iss, "123");
  assert.ok(decoded.iat <= now && decoded.exp > now && decoded.exp - decoded.iat <= 600);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${claims}`),
    publicKey, Buffer.from(signature, "base64url")));
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-installation-token");
  assert.deepEqual(JSON.parse(requests[1].options.body), { name: "owner-decision" });
  for (const status of [401, 403, 429, 500]) {
    fetchMock.mock.mockImplementation(async () => new Response("", { status }));
    await assert.rejects(githubClient(config)(42), new RegExp(String(status)));
    await assert.rejects(api("/repos/demo/repo/pulls/1"), new RegExp(String(status)));
  }
  fetchMock.mock.mockImplementation(async () => { throw new Error("Network unavailable"); });
  await assert.rejects(githubClient(config)(42), /Network unavailable/);
  await assert.rejects(api("/repos/demo/repo/pulls/1"), /Network unavailable/);
  fetchMock.mock.mockImplementation(async () => new Response("{invalid-json"));
  await assert.rejects(githubClient(config)(42), SyntaxError);
  await assert.rejects(api("/repos/demo/repo/pulls/1"), SyntaxError);
});

test("local gate demo: real HTTP, simulated GitHub, and the weakened support promise", async t => {
  const secret = "local-http-test-secret";
  const options = { reviews: [] };
  const { api, writes } = fixture(options);
  let unavailable = false;
  const errors = t.mock.method(console, "error", () => {});
  const server = createServer(webhook({ secret, org: "demo" }, async id => {
    assert.equal(id, 42);
    if (unavailable) throw new Error("GitHub unavailable");
    return api;
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const post = (body, event = "pull_request", signature) => fetch(url, {
    method: "POST", body,
    headers: {
      "x-github-event": event,
      "x-hub-signature-256": signature ??
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  });
  t.diagnostic("SIMULATION: real loopback HTTP + signed webhooks; GitHub API, users, and teams are fixtures.");
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(`${url}/wrong`, { method: "POST" })).status, 404);
  for (const signature of ["", "sha256=bad", `sha256=${"0".repeat(64)}`]) {
    assert.equal((await post(JSON.stringify(payload), "pull_request", signature)).status, 401);
  }
  assert.equal((await post("x".repeat(1024 * 1024 + 1))).status, 413);
  assert.equal((await post('{"action":"ignored"}', "ping")).status, 204);
  assert.equal((await post(JSON.stringify({ ...payload, action: "labeled" }))).status, 204);
  assert.equal(writes.length, 0);
  assert.equal((await post(JSON.stringify(payload))).status, 200);
  assert.equal(writes[0].body.status, "in_progress");
  assert.equal(writes.at(-1).body.conclusion, "action_required");
  t.diagnostic("PR opened: in_progress -> action_required; @demo/support-team is tagged.");
  assert.match(writes[1].body.body, /@demo\/support-team/);
  for (const [label, submitted] of [
    ["non-owner", review("outsider")],
    ["stale owner", review("sam", "APPROVED", "old-head")],
    ["current-head owner", review("sam")],
  ]) {
    options.reviews.push(submitted);
    assert.equal((await post(JSON.stringify({ ...payload, action: "submitted" }),
      "pull_request_review")).status, 200);
    const expected = label === "current-head owner" ? "success" : "action_required";
    assert.equal(writes.at(-1).body.conclusion, expected);
    t.diagnostic(`${label} approval: ${expected}.`);
  }
  assert.equal((await post("{invalid-json")).status, 500);
  unavailable = true;
  assert.equal((await post(JSON.stringify(payload))).status, 500);
  unavailable = false;
  assert.equal((await post(JSON.stringify(payload))).status, 200);
  assert.equal(writes.at(-1).body.conclusion, "success");
  assert.equal((await post(JSON.stringify({ ...payload, action: "closed" }))).status, 200);
  assert.equal(writes.at(-1).body.conclusion, "success");
  options.reviews.push(review("sam", "DISMISSED"));
  assert.equal((await post(JSON.stringify({ ...payload, action: "dismissed" }),
    "pull_request_review")).status, 200);
  assert.equal(writes.at(-1).body.conclusion, "action_required");
  t.diagnostic("Owner dismissal: action_required.");
  options.reviews.push(review("sam"));
  assert.equal((await post(JSON.stringify({ ...payload, action: "submitted" }),
    "pull_request_review")).status, 200);
  assert.equal(writes.at(-1).body.conclusion, "success");
  assert.ok(errors.mock.callCount() >= 2);

  const directory = mkdtempSync(join(tmpdir(), "owners-decide-product-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const folder of ["tests/privacy", "tests/support"]) {
    mkdirSync(join(directory, folder), { recursive: true });
  }
  for (const file of ["accounts.js", "package.json",
    "tests/privacy/retention.test.js", "tests/support/restore.test.js"]) {
    writeFileSync(join(directory, file), readFileSync(new URL(`../../${file}`, import.meta.url)));
  }
  const supportPath = join(directory, "tests/support/restore.test.js");
  const baseline = readFileSync(supportPath, "utf8").replace('restore("ada", 29)', 'restore("ada", 60)');
  assert.match(baseline, /restore\("ada", 60\)/);
  writeFileSync(supportPath, baseline);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const productTests = () => spawnSync(process.execPath, ["--test",
    "tests/privacy/retention.test.js", "tests/support/restore.test.js",
  ], { cwd: directory, env, encoding: "utf8" });
  const red = productTests();
  assert.equal(red.status, 1, red.stdout + red.stderr);
  assert.match(red.stdout, /# pass 4/);
  assert.match(red.stdout, /# fail 1/);
  assert.match(red.stdout, /Account data has been deleted/);
  t.diagnostic("Unmodified product contract: privacy 4 pass; day-60 support 1 FAIL (intentional).");
  writeFileSync(supportPath, baseline.replace('restore("ada", 60)', 'restore("ada", 29)'));
  const green = productTests();
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /# pass 5/);
  t.diagnostic("Temporary copy only: changing 60 -> 29 makes all 5 product tests PASS.");
  t.diagnostic("Green CI is not owner consent. No repository files changed; no live merge controls were tested.");
});

test("one process serializes simultaneous deliveries rather than overlapping decisions", async () => {
  const secret = "local-queue-test-secret";
  const { api } = fixture();
  let releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let clients = 0;
  const handler = webhook({ secret, org: "demo" }, async () => {
    clients++;
    if (clients === 1) {
      firstStarted();
      await firstBlocked;
    }
    return api;
  });
  const deliver = async () => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = Readable.from([body]);
    req.method = "POST";
    req.url = "/webhook";
    req.headers = {
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    };
    const res = { writeHead(status) { this.status = status; return this; }, end() {} };
    await handler(req, res);
    assert.equal(res.status, 200);
  };
  const first = deliver();
  await started;
  const second = deliver();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clients, 1);
  } finally {
    releaseFirst();
    await Promise.all([first, second]);
  }
  assert.equal(clients, 2);
});

test("workflow pins every action and final guard rejects every non-success result", () => {
  const workflow = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
  const actions = [...workflow.matchAll(/uses:\s*(\S+)/g)];
  assert.equal(actions.length, 2);
  for (const [, action] of actions) assert.match(action, /@[a-f0-9]{40}$/);
  assert.match(workflow, /run: node --test \.github\/owner-decision\/server\.test\.mjs/);
  assert.match(workflow, /run: node --test tests\/privacy\/\*\.test\.js tests\/support\/\*\.test\.js/);
  assert.doesNotMatch(workflow, /run: npm/);
  const finalJob = workflow.split("  ci-required:\n")[1];
  assert.ok(finalJob);
  assert.match(finalJob, /if: \$\{\{ always\(\) \}\}/);
  assert.match(finalJob, /needs: tests/);
  assert.match(finalJob, /TEST_RESULT: \$\{\{ needs.tests.result \}\}/);
  const command = finalJob.match(/run: (.+)/)[1];
  for (const result of ["success", "failure", "cancelled", "skipped", "", "unexpected"]) {
    const child = spawnSync("sh", ["-c", command], { env: { ...process.env, TEST_RESULT: result } });
    assert.equal(child.status, result === "success" ? 0 : 1, `Result: ${result}`);
  }
});

test("CLI refuses to start when any required App configuration is missing", () => {
  const configured = {
    APP_ID: "123", PRIVATE_KEY_PATH: "/not-read-until-all-fields-exist",
    WEBHOOK_SECRET: "test-startup-secret", OWNER_ORG: "demo",
  };
  for (const name of Object.keys(configured)) {
    const env = { ...configured };
    delete env[name];
    const actual = spawnSync(process.execPath, [
      new URL("./server.mjs", import.meta.url).pathname,
    ], { env, encoding: "utf8" });
    assert.equal(actual.status, 1);
    assert.match(actual.stderr, new RegExp(`Missing ${name}`));
  }
});

test("changing unowned package scripts to exit zero cannot redirect protected CI commands", t => {
  const directory = mkdtempSync(join(tmpdir(), "owners-decide-ci-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const folder of ["tests/privacy", "tests/support", ".github/owner-decision"]) {
    mkdirSync(join(directory, folder), { recursive: true });
  }
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    type: "module", scripts: { test: "exit 0", "test:gate": "exit 0" },
  }));
  const fail = 'import test from "node:test"; import assert from "node:assert/strict"; ' +
    'test("must still run", () => assert.fail("real failing contract"));\n';
  writeFileSync(join(directory, "tests/privacy/privacy.test.js"), 'import "node:test";\n');
  writeFileSync(join(directory, "tests/support/support.test.js"), fail);
  writeFileSync(join(directory, ".github/owner-decision/server.test.mjs"), fail);
  const env = { ...process.env };
  // Child CI commands must not inherit the enclosing Node test runner's IPC mode.
  delete env.NODE_TEST_CONTEXT;
  assert.equal(spawnSync("npm", ["test", "--silent"], { cwd: directory, env }).status, 0);
  const workflow = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
  const commands = [...workflow.matchAll(/- run: (node --test .+)/g)].map(match => match[1]);
  assert.equal(commands.length, 2);
  for (const command of commands) {
    const actual = spawnSync("sh", ["-c", command], { cwd: directory, env, encoding: "utf8" });
    assert.equal(actual.status, 1, `${command}\n${actual.stdout}\n${actual.stderr}`);
    assert.match(actual.stdout, /real failing contract/);
  }
});

test("alternate-base PRs cannot overwrite the main PR's required check", async () => {
  const mainPr = {
    number: 2, state: "open", head: { sha: "head" }, base: { ref: "main" },
    user: { login: "author" }, changed_files: 1,
  };
  const { api, writes, calls } = fixture({
    base: "staging", openPrs: [mainPr], pullRequests: { 2: mainPr },
    // The alternate-base PR could have no owned changes; only main's diff is consulted.
  });
  await reconcile(payload, { org: "demo" }, api);
  assert.ok(calls.some(path => path.includes("/pulls/2/files?")));
  assert.equal(calls.some(path => path.includes("/pulls/1/files?")), false);
  assert.equal(writes.at(-1).body.conclusion, "action_required");
  const unrelated = fixture({ base: "staging" });
  await reconcile(payload, { org: "demo" }, unrelated.api);
  assert.deepEqual(unrelated.writes, []);
});

test("multiple main PRs sharing a head fail closed; closing a duplicate re-evaluates", async () => {
  const mainPr = {
    number: 1, state: "open", head: { sha: "head" }, base: { ref: "main" },
    user: { login: "author" }, changed_files: 1,
  };
  const options = { openPrs: [mainPr, { ...mainPr, number: 2 }], reviews: [review("sam")] };
  const { api, writes } = fixture(options);
  for (const action of ["opened", "reopened", "synchronize", "edited"]) {
    await reconcile({ ...payload, action }, { org: "demo" }, api);
    assert.equal(writes.at(-1).body.conclusion, "action_required");
    assert.match(writes.at(-1).body.output.title, /Ambiguous/);
  }
  options.openPrs = [mainPr];
  await reconcile({ ...payload, pull_request: { number: 2 }, action: "closed" }, { org: "demo" }, api);
  assert.equal(writes.at(-1).body.conclusion, "success");
});

test("PR state/head/base changed during evaluation cannot produce success", async () => {
  const candidate = { number: 2, head: { sha: "head" } };
  for (const change of [{ state: "closed" }, { base: { ref: "other" } }, { head: { sha: "new" } }]) {
    const { api, writes } = fixture({
      openPrs: [candidate], pullRequests: { 2: {
        state: "open", base: { ref: "main" }, head: { sha: "head" }, ...change,
      } },
    });
    await assert.rejects(reconcile(payload, { org: "demo" }, api), /PR changed during owner evaluation/);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.status, "in_progress");
  }
});
