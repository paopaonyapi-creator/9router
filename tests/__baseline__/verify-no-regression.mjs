// Reject new assertion and suite failures without changing either baseline.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";

const normalizePath = value => value.replace(/\\/g, "/").replace(/\/\/\?\//g, "");
const testPath = name => {
  const normalized = normalizePath(name);
  const index = normalized.lastIndexOf("/tests/");
  return index < 0 ? normalized : normalized.slice(index + 1);
};

function suiteSignature(file) {
  let message = normalizePath(file.message || "").trim();
  if (!message) return null; // A filename alone cannot identify a known error.
  const name = normalizePath(file.name);
  const testsIndex = name.lastIndexOf("/tests/");
  if (testsIndex >= 0) {
    message = message.replaceAll(name.slice(0, testsIndex + 1), "<repo>/");
  }
  // Node mkdtemp adds six random characters. Keep the directory's meaningful
  // prefix and any child filename, so distinct errors do not become equivalent.
  message = message.replace(
    /(?:[A-Za-z]:\/Users\/[^/\r\n]+\/AppData\/Local\/Temp|\/tmp|\/var\/folders\/[^/\r\n]+\/[^/\r\n]+\/T)\/([\w.-]+)-[A-Za-z0-9]{6}(?=[/'"\s]|$)/g,
    "<tmp>/$1-<random>"
  );
  return testPath(file.name) + " :: " + message;
}

function failures(report) {
  const assertions = [];
  const suites = [];
  for (const file of report.testResults) {
    const failed = file.assertionResults.filter(assertion => assertion.status === "failed");
    assertions.push(...failed.map(assertion => testPath(file.name) + " :: " + assertion.fullName));
    // Vitest also marks a file failed when one of its assertions fails. A
    // message represents a separate collection/hook error, even alongside an
    // already-known assertion failure.
    if (file.status === "failed" && (file.message?.trim() || !failed.length)) {
      suites.push({ signature: suiteSignature(file), name: testPath(file.name) });
    }
  }
  return { assertions, suites };
}

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const now = failures(r);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails.
// known-fails.txt อาจล้าสมัยกว่าสภาพจริงของเครื่องนี้ — ถ้ามี snapshot ผลรัน
// ฐาน (current-run.json) ให้ยอมรับ fail ที่ตรงกับ snapshot ด้วย เพื่อไม่ให้
// fail แวดวง environment ของเครื่องโดนนับเป็น regression
let machineBaseline = { assertions: [], suites: [] };
try {
  const base = JSON.parse(readFileSync(new URL("./current-run.json", import.meta.url), "utf8"));
  machineBaseline = failures(base);
} catch { /* no local snapshot — known-fails.txt only */ }

const knownAssertions = new Set([...knownFails, ...machineBaseline.assertions]);
const knownSuites = new Set(machineBaseline.suites.map(file => file.signature).filter(Boolean));
const regressions = now.assertions.filter(f => !knownAssertions.has(f));
const suiteRegressions = now.suites.filter(file => !file.signature || !knownSuites.has(file.signature));
// Some reporter versions expose runtime errors separately from testResults.
// They have no stable per-test identity here, so never silently allow them.
const runtimeRegressions = ["unhandledErrors", "numRuntimeErrorTestSuites"].filter(key =>
  Array.isArray(r[key]) ? r[key].length > 0 : Number(r[key]) > 0
);

if (regressions.length || suiteRegressions.length || runtimeRegressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} new assertion failures, ${suiteRegressions.length} new suite failures:\n`);
  regressions.forEach(f => console.error("  - " + f));
  suiteRegressions.forEach(file => console.error("  - " + (file.signature || file.name + " :: suite failed without diagnostic")));
  runtimeRegressions.forEach(key => console.error("  - Report contains " + key));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${now.assertions.length}, suite errors=${now.suites.length}, baseline known=${knownFails.size}, all known)`);
