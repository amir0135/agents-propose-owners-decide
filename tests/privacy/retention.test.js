import assert from "node:assert/strict";
import test from "node:test";
import { Accounts } from "../../accounts.js";

test("personal data is deleted within 30 days of account deletion", () => {
  const accounts = new Accounts();
  accounts.create("ada", { name: "Ada", email: "ada@example.test" });
  accounts.delete("ada", 0);
  assert.equal(accounts.snapshot(29).length, 1);
  assert.deepEqual(accounts.snapshot(30), []);
  assert.throws(() => accounts.restore("ada", 30), /data has been deleted/);
});

test("retention is measured from deletion, not account creation or repeated deletion", () => {
  const accounts = new Accounts();
  accounts.create("ada", { name: "Ada" });
  accounts.delete("ada", 10);
  accounts.delete("ada", 39);
  assert.equal(accounts.snapshot(39).length, 1);
  assert.deepEqual(accounts.snapshot(40), []);
  accounts.purge(100);
  assert.deepEqual(accounts.snapshot(100), []);
});

test("day-29 restore is complete, isolated from caller mutations, and cancels deletion", () => {
  const accounts = new Accounts();
  const original = { name: "Ada", preferences: { language: "en" }, notes: ["support history"] };
  accounts.create("ada", original);
  original.preferences.language = "changed";
  accounts.delete("ada", 0);
  const restored = accounts.restore("ada", 29);
  assert.deepEqual(restored, {
    name: "Ada", preferences: { language: "en" }, notes: ["support history"],
  });
  restored.notes.push("caller mutation");
  const snapshot = accounts.snapshot(60);
  assert.equal(snapshot[0].deletedAt, null);
  assert.deepEqual(snapshot[0].personalData.notes, ["support history"]);
  snapshot[0].personalData.name = "caller mutation";
  assert.equal(accounts.snapshot(60)[0].personalData.name, "Ada");
  accounts.delete("ada", 60);
  assert.equal(accounts.snapshot(89).length, 1);
  assert.deepEqual(accounts.snapshot(90), []);
});

test("purge removes only expired deleted accounts; missing and duplicate accounts throw", () => {
  const accounts = new Accounts();
  accounts.create("expired", { name: "Expired" });
  accounts.create("recent", { name: "Recent" });
  accounts.create("active", { name: "Active" });
  assert.throws(() => accounts.create("active", {}), /already exists/);
  assert.throws(() => accounts.delete("missing", 0), /not found/);
  assert.throws(() => accounts.restore("missing", 0), /data has been deleted/);
  accounts.delete("expired", 0);
  accounts.delete("recent", 10);
  accounts.purge(30);
  assert.deepEqual(accounts.snapshot(30).map(account => account.personalData.name), ["Recent", "Active"]);
  assert.throws(() => accounts.restore("expired", 60), /data has been deleted/);
  assert.deepEqual(accounts.restore("active", 60), { name: "Active" });
});
