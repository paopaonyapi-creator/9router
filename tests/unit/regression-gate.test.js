import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    // Only remove this test's freshly allocated directory, never a checkout.
    expect(dirname(resolve(fixture))).toBe(resolve(tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});

const assertion = fullName => ({ fullName, status: "failed" });
const suite = (name, message = "", assertionResults = []) => ({
  name, message, assertionResults, status: "failed",
});
const report = (...testResults) => ({ testResults });

function runGate(current, { baseline, known = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "9router-regression-gate-"));
  fixtures.push(root);
  const baselineDir = join(root, "tests", "__baseline__");
  mkdirSync(baselineDir, { recursive: true });
  const script = join(baselineDir, "verify-no-regression.mjs");
  copyFileSync(new URL("../__baseline__/verify-no-regression.mjs", import.meta.url), script);
  const knownPath = join(baselineDir, "known-fails.txt");
  const baselinePath = join(baselineDir, "current-run.json");
  writeFileSync(knownPath, known.join("\n"));
  if (baseline) writeFileSync(baselinePath, JSON.stringify(baseline));
  const input = join(root, "results.json");
  writeFileSync(input, JSON.stringify(current));
  const result = spawnSync(process.execPath, [script, input], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  // Verification must never refresh a baseline to make a regression pass.
  expect(readFileSync(knownPath, "utf8")).toBe(known.join("\n"));
  if (baseline) expect(readFileSync(baselinePath, "utf8")).toBe(JSON.stringify(baseline));
  return { code: result.status, output: result.stdout + result.stderr };
}

describe("test regression gate CLI", () => {
  it("accepts a report without failures", () => {
    expect(runGate(report()).code).toBe(0);
  });

  it.each([
    "Cannot find package 'new-dependency' imported from /app/tests/unit/example.test.js",
    "No test suite found in file /app/tests/unit/example.test.js",
    "afterAll cleanup failed",
  ])("rejects a new suite failure with no failed assertions: %s", message => {
    const result = runGate(report(suite("/app/tests/unit/example.test.js", message)));
    expect(result.code).toBe(1);
    expect(result.output).toContain("1 new suite failures");
  });

  it("accepts the same known suite error across Windows and Unix checkouts", () => {
    const baseline = report(suite(
      "C:\\old checkout\\tests\\unit\\example.test.js",
      "Cannot find package 'lowdb' imported from C:\\old checkout\\tests\\unit\\example.test.js",
    ));
    const current = report(suite(
      "/home/runner/new checkout/tests/unit/example.test.js",
      "Cannot find package 'lowdb' imported from /home/runner/new checkout/tests/unit/example.test.js",
    ));
    const result = runGate(current, { baseline });
    expect(result.code).toBe(0);
    expect(result.output).toContain("suite errors=1");
  });

  it("rejects a different import failure in a known failed suite", () => {
    const name = "/app/tests/unit/example.test.js";
    const baseline = report(suite(name, "Cannot find package 'lowdb'"));
    const current = report(suite(name, "Cannot find package 'new-dependency'"));
    expect(runGate(current, { baseline }).code).toBe(1);
  });

  it("normalizes temporary roots and random suffixes while retaining the error", () => {
    const name = "tests/unit/example.test.js";
    const baseline = report(suite(name,
      "EPERM, Permission denied: \\\\?\\C:\\Users\\Old User\\AppData\\Local\\Temp\\9router-cached-e2e-93BQs8"));
    const current = report(suite(name, "EPERM, Permission denied: /tmp/9router-cached-e2e-Ab12Cd"));
    expect(runGate(current, { baseline }).code).toBe(0);
    const different = report(suite(name, "EPERM, Permission denied: /tmp/9router-other-Ab12Cd"));
    expect(runGate(different, { baseline }).code).toBe(1);
  });

  it("rejects a suite without a diagnostic even if its filename was known", () => {
    const current = report(suite("tests/unit/example.test.js"));
    expect(runGate(current, { baseline: current }).code).toBe(1);
  });

  it("rejects a new assertion failure", () => {
    const current = report(suite("/app/tests/unit/example.test.js", "", [assertion("new failure")]));
    const result = runGate(current);
    expect(result.code).toBe(1);
    expect(result.output).toContain("1 new assertion failures");
    expect(result.output).toContain("0 new suite failures");
  });

  it("retains known-fails assertion matching across checkout layouts", () => {
    const current = report(suite("D:\\repo\\tests\\unit\\example.test.js", "", [assertion("known failure")]));
    const known = ["tests/unit/example.test.js :: known failure"];
    expect(runGate(current, { known }).code).toBe(0);
  });

  it("retains machine-baseline assertion matching across checkout layouts", () => {
    const baseline = report(suite("C:\\old\\tests\\unit\\example.test.js", "", [assertion("known failure")]));
    const current = report(suite("/home/new/tests/unit/example.test.js", "", [assertion("known failure")]));
    expect(runGate(current, { baseline }).code).toBe(0);
  });

  it("rejects a new hook error alongside a known failed assertion", () => {
    const current = report(suite("tests/unit/example.test.js", "afterAll cleanup failed", [assertion("known failure")]));
    const known = ["tests/unit/example.test.js :: known failure"];
    expect(runGate(current, { known }).code).toBe(1);
  });

  it.each([
    { unhandledErrors: [{ message: "uncaught exception" }] },
    { unhandledErrors: 1 },
    { numRuntimeErrorTestSuites: 1 },
  ])("rejects runtime errors supplied outside testResults: %j", runtimeErrors => {
    const current = { ...report(), ...runtimeErrors };
    expect(runGate(current, { baseline: current }).code).toBe(1);
  });
});
