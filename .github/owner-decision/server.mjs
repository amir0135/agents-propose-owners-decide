import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function ownersForFiles(files, org) {
  const teams = new Set();
  for (const file of files) {
    // Renaming away from an owned path still requires its owner's decision.
    for (const path of [file.filename, file.previous_filename].filter(Boolean)) {
      if (path.startsWith("tests/privacy/")) teams.add(`${org}/privacy-team`);
      else if (path.startsWith("tests/support/")) teams.add(`${org}/support-team`);
      else if (/^(tests|specs|\.github)(\/|$)/.test(path)) teams.add(`${org}/maintainers`);
    }
  }
  return [...teams].sort();
}

export async function approvedTeams(reviews, teams, sha, isMember) {
  const latest = new Map();
  for (const review of reviews) {
    if (review.state !== "PENDING") latest.set(review.user.login, review);
  }
  const approved = new Set();
  for (const [login, review] of latest) {
    if (review.state !== "APPROVED" || review.commit_id !== sha) continue;
    for (const team of teams) {
      if (await isMember(team, login)) approved.add(team);
    }
  }
  return teams.filter(team => approved.has(team));
}

export function githubClient(config) {
  return async installation => {
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
    const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iat: now - 60, exp: now + 540, iss: config.appId,
    })}`;
    const signature = createSign("RSA-SHA256").update(message).sign(config.privateKey, "base64url");
    const request = async (path, method, body, token) => {
      const response = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status}`);
      return response.json();
    };
    const { token } = await request(`/app/installations/${installation}/access_tokens`,
      "POST", {}, `${message}.${signature}`);
    return (path, method = "GET", body) => request(path, method, body, token);
  };
}

async function list(api, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export async function reconcile(payload, config, api) {
  const repo = `/repos/${payload.repository.full_name}`;
  const eventPr = await api(`${repo}/pulls/${payload.pull_request.number}`);
  const sha = eventPr.head.sha;
  // Checks belong to commits, not PRs. Never let an alternate-base PR approve main.
  const candidates = (await list(api, `${repo}/pulls?state=open&base=main`))
    .filter(pr => pr.head.sha === sha);
  if (!candidates.length) return;
  const check = await api(`${repo}/check-runs`, "POST", {
    name: "owner-decision", head_sha: sha, status: "in_progress",
    output: { title: "Evaluating owner decisions", summary: "Plain rules; no AI." },
  });
  if (candidates.length !== 1) {
    await api(`${repo}/check-runs/${check.id}`, "PATCH", {
      status: "completed", conclusion: "action_required",
      output: {
        title: "Ambiguous shared PR head",
        summary: "Multiple open PRs to main share this commit. Close duplicates or use distinct head commits.",
      },
    });
    return;
  }
  const number = candidates[0].number;
  const pr = await api(`${repo}/pulls/${number}`);
  if (pr.state !== "open" || pr.base.ref !== "main" || pr.head.sha !== sha) {
    throw new Error("PR changed during owner evaluation; redeliver the latest event");
  }
  const files = await list(api, `${repo}/pulls/${number}/files`);
  // GitHub caps this endpoint at 3,000 files. Never approve a partial list.
  if (files.length !== pr.changed_files) throw new Error("Incomplete PR file list");
  const teams = ownersForFiles(files, config.org);
  const reviews = await list(api, `${repo}/pulls/${number}/reviews`);
  const members = new Map();
  for (const team of teams) {
    const [org, slug] = team.split("/");
    members.set(team, await list(api, `/orgs/${org}/teams/${slug}/members`));
  }
  const approved = await approvedTeams(reviews, teams, pr.head.sha, async (team, login) =>
    login !== pr.user.login &&
    members.get(team).some(member => member.login.toLowerCase() === login.toLowerCase()));
  const missing = teams.filter(team => !approved.includes(team));
  if (teams.length && payload.action !== "submitted" && payload.action !== "dismissed") {
    await api(`${repo}/issues/${number}/comments`, "POST", {
      body: `Owner decision required from ${teams.map(team => `@${team}`).join(", ")}. ` +
        "Each affected team must approve the current PR head. Do not weaken tests to make CI green.",
    });
  }
  await api(`${repo}/check-runs/${check.id}`, "PATCH", {
    status: "completed", conclusion: missing.length ? "action_required" : "success",
    output: {
      title: missing.length ? "Owner approval required" : "Owner decisions satisfied",
      summary: missing.length ? `Awaiting current-head approval: ${missing.join(", ")}.` :
        teams.length ? "Every affected team approved this head." : "No owned paths changed.",
    },
  });
}

export function webhook(config, client = githubClient(config)) {
  // Serialize deliveries so a dismissal cannot race an earlier approval in this process.
  let queue = Promise.resolve();
  return async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/webhook") {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const expected = Buffer.from(`sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`);
      const actual = Buffer.from(req.headers["x-hub-signature-256"] ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.writeHead(401).end();
        return;
      }
      const event = req.headers["x-github-event"];
      const payload = JSON.parse(body);
      const actions = event === "pull_request" ?
        ["opened", "reopened", "synchronize", "ready_for_review", "edited", "closed"] :
        event === "pull_request_review" ? ["submitted", "dismissed"] : [];
      if (!actions.includes(payload.action)) {
        res.writeHead(204).end();
        return;
      }
      const work = queue.then(async () => reconcile(payload, config, await client(payload.installation.id)));
      queue = work.catch(error => console.error("owner-decision delivery failed:", error));
      await work;
      res.writeHead(200).end();
    } catch (error) {
      console.error("owner-decision request failed:", error);
      res.writeHead(500).end();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const name of ["APP_ID", "PRIVATE_KEY_PATH", "WEBHOOK_SECRET", "OWNER_ORG"]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  const config = {
    appId: process.env.APP_ID,
    privateKey: readFileSync(process.env.PRIVATE_KEY_PATH, "utf8"),
    secret: process.env.WEBHOOK_SECRET,
    org: process.env.OWNER_ORG,
  };
  createServer(webhook(config)).listen(3000, "127.0.0.1", () => {
    console.log("owner-decision listening on http://127.0.0.1:3000/webhook");
  });
}
