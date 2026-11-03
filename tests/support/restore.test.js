import assert from "node:assert/strict";
import test from "node:test";
import { Accounts } from "../../accounts.js";

test("a deleted account can still be fully restored", () => {
  const accounts = new Accounts();
  const personalData = { name: "Ada", email: "ada@example.test" };
  accounts.create("ada", personalData);
  accounts.delete("ada", 0);
  assert.deepEqual(accounts.restore("ada", 60), personalData);
});
