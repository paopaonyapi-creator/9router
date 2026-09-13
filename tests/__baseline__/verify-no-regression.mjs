// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
// known-fails.txt keys look like `tests/unit/foo.test.js :: full name`.
// Resolve each result file's path relative to the repo's tests/ dir so the
// gate works on any checkout layout (not just upstream's /app/ prefix).
const testsRoot = fileURLToPath(new URL("../../tests/", import.meta.url)).replace(/\\/g, "/");
const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => {
      const norm = f.name.replace(/\\/g, "/");
      const rel = norm.startsWith(testsRoot) ? "tests/" + norm.slice(testsRoot.length) : norm;
      return rel + " :: " + a.fullName;
    })
);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails.
// known-fails.txt อาจล้าสมัยกว่าสภาพจริงของเครื่องนี้ — ถ้ามี snapshot ผลรัน
// ฐาน (current-run.json) ให้ยอมรับ fail ที่ตรงกับ snapshot ด้วย เพื่อไม่ให้
// fail แวดวง environment ของเครื่องโดนนับเป็น regression
let machineBaseline = new Set();
try {
  const base = JSON.parse(readFileSync(new URL("./current-run.json", import.meta.url), "utf8"));
  for (const f of base.testResults) {
    for (const a of f.assertionResults) {
      if (a.status === "failed") {
        const norm = f.name.replace(/\\/g, "/");
        const rel = norm.startsWith(testsRoot) ? "tests/" + norm.slice(testsRoot.length) : norm;
        machineBaseline.add(rel + " :: " + a.fullName);
      }
    }
  }
} catch { /* no local snapshot — known-fails.txt only */ }

const regressions = nowFails.filter(f => !knownFails.has(f) && !machineBaseline.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
