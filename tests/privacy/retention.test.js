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
