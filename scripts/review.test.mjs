import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBuildSucceeded, reviewResponseSchema } from "./lib.mjs";

test("reviewResponseSchemaはverificationをnull許容にしつつrequiredのままにする", () => {
  const findingSchema = reviewResponseSchema.properties.findings.items;
  const verification = findingSchema.properties.verification;

  assert.ok(findingSchema.required.includes("verification"));
  assert.deepEqual(verification.type, ["object", "null"]);
  assert.deepEqual(verification.required, ["probe", "arguments", "expected"]);
  assert.deepEqual(verification.properties.probe.enum, ["git_ls_files"]);
});

test("computeBuildSucceededはbuildを含み成功したcheckがあればtrue", () => {
  const checks = [{ name: "Build", status: "completed", conclusion: "success" }];
  assert.equal(computeBuildSucceeded(checks), true);
});

test("computeBuildSucceededは進行中のcheckをbuild成功として扱わない", () => {
  const checks = [{ name: "Build", status: "in_progress", conclusion: null }];
  assert.equal(computeBuildSucceeded(checks), false);
});

test("computeBuildSucceededはAIレビュー自身のcheckを除外する", () => {
  const checks = [{ name: "AI Review Build Summary", status: "completed", conclusion: "success" }];
  assert.equal(computeBuildSucceeded(checks), false);
});
