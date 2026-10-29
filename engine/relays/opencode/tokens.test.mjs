import { test } from "node:test";
import assert from "node:assert/strict";
import { sumTokens } from "./tokens.mjs";

test("sumTokens", () => {
  assert.equal(sumTokens({ input: 10, output: 5 }), 15);
  assert.equal(sumTokens({ input: 10, output: 5, cache: { read: 2, write: 100 } }), 117);
  assert.equal(sumTokens(null), 0);
  assert.equal(sumTokens(undefined), 0);
  assert.equal(sumTokens({}), 0);
  assert.equal(sumTokens({ input: 3, model: "x" }), 3);
});
