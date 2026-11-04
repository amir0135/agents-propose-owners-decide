import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { approvedTeams } from "./owner-decision/server.mjs";

const terminal = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = terminal[Symbol.asyncIterator]();
terminal.on("SIGINT", () => terminal.close());
process.once("SIGINT", () => terminal.close());
class Cancelled extends Error {}

async function choose(prompt, choices) {
  for (;;) {
    process.stdout.write(`${prompt} (q to quit): `);
    const answer = await lines.next();
    if (answer.done || answer.value.trim().toLowerCase() === "q") throw new Cancelled();
    const value = answer.value.trim().toLowerCase();
    if (choices.includes(value)) return value;
    console.log(`Choose ${choices.map(choice => choice || "Enter").join(", ")}.`);
  }
}

let directory;
try {
  console.log("Privacy: delete data by day 30. Support: fully restore on day 60.");
  console.log("These promises conflict. No AI. No live GitHub calls or merge enforcement.");
  await choose("Press Enter to run the original tests", [""]);
  directory = mkdtempSync(join(tmpdir(), "owners-talk-"));
  for (const folder of ["tests/privacy", "tests/support"]) {
    mkdirSync(join(directory, folder), { recursive: true });
  }
  for (const file of ["package.json", "accounts.js",
    "tests/privacy/retention.test.js", "tests/support/restore.test.js"]) {
    writeFileSync(join(directory, file), readFileSync(new URL(`../${file}`, import.meta.url)));
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = expected => {
    const result = spawnSync(process.execPath, ["--test",
      "tests/privacy/retention.test.js", "tests/support/restore.test.js",
    ], { cwd: directory, env, encoding: "utf8" });
    if (result.error) throw result.error;
    const summary = expected ? /# pass 4[\s\S]*# fail 1/ : /# pass 5[\s\S]*# fail 0/;
    if (result.status !== expected || !summary.test(result.stdout) ||
        (expected && !result.stdout.includes("Account data has been deleted"))) {
      throw new Error(`Unexpected test result:\n${result.stdout}\n${result.stderr}`);
    }
    console.log(expected ? "RED: privacy passes; day-60 support fails." : "GREEN: all product tests pass.");
  };
  run(1);
  const decision = await choose("1 = change 60 to 29 in a temporary copy; 2 = keep the contract", ["1", "2"]);
  if (decision === "2") {
    console.log("Contract kept. CI stays red: the teams must resolve the policy conflict.");
  } else {
    const file = join(directory, "tests/support/restore.test.js");
    const original = readFileSync(file, "utf8");
    if (!original.includes('restore("ada", 60)')) throw new Error("Expected day-60 baseline test");
    writeFileSync(file, original.replace('restore("ada", 60)', 'restore("ada", 29)'));
    run(0);
    console.log("The promise was weakened, not fixed. Simulated owner-decision: action_required.");
    for (;;) {
      const approval = await choose("n = non-owner; s = stale owner; o = current-head owner", ["n", "s", "o"]);
      const teams = await approvedTeams([{
        user: { login: approval === "n" ? "outsider" : "support-owner" },
        state: "APPROVED", commit_id: approval === "s" ? "old-head" : "head",
      }], ["demo/support-team"], "head", async (_, login) => login === "support-owner");
      if (teams.length) {
        console.log("SIMULATED owner-decision: success. Owner consent is separate from green CI.");
        console.log("Approving this change accepts a weaker promise; real owners may reject it.");
        break;
      }
      console.log("SIMULATED owner-decision: action_required. That approval does not count.");
    }
  }
} catch (error) {
  if (error instanceof Cancelled) console.log("\nDemo cancelled.");
  else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  terminal.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  console.log("Checkout unchanged. Temporary copy removed. Live App setup is still separate.");
}
