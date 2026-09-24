import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// eslint-plugin-react-hooks v7 (pulled in by eslint-config-next 16.3.6) promotes its
// compiler-era rules to errors, and this codebase carries pre-existing sites across
// ~56 files. Downgraded to warnings so `npx eslint .` is usable as a gate. This
// reclassifies debt, it does not fix it — clear these per file and drop the entry, so
// each rule goes back to error and cannot regress. `react-hooks/immutability` is
// already cleared (39 access-before-declare effects were reordered in v0.5.87) and is
// deliberately no longer listed. Several purity hits are also not genuine: they are
// Date.now() in event handlers, or in a useMemo whose deps include the refresh tick.
//
// set-state-in-effect (109 sites / 53 files) was triaged on 2026-09-25 and left alone
// on purpose: no effect sets state without a dependency array, so nothing re-runs every
// render, and the sites are the sanctioned-but-discouraged shapes — syncing a prop into
// state, seeding state from a fetched response, or a spinner flag before an await.
// Converting them to render-phase adjustment is not mechanical: `if (status !==
// initialStatus) setStatus(initialStatus)` renders forever whenever the parent passes a
// fresh object literal, which is exactly what the deps array prevents today. Re-triage
// per file with browser verification before changing any of these; ~50 of the 109 sit in
// the near-identical cli-tools ToolCard family, so one wrong move replicates 14 times.
const REACT_HOOKS_DEBT = [
  "react-hooks/set-state-in-effect",
  "react-hooks/purity",
  "react-hooks/refs",
];

// Flat config resolves a rule's plugin from the object that declares it, so the
// severity has to be rewritten in place on the object carrying the react-hooks plugin
// — a separate rules-only object fails with "plugin is not defined".
const withDebtWarned = nextVitals.map((config) => {
  const applicable = REACT_HOOKS_DEBT.filter((rule) => rule in (config.rules || {}));
  if (!applicable.length) return config;
  return {
    ...config,
    rules: { ...config.rules, ...Object.fromEntries(applicable.map((rule) => [rule, "warn"])) },
  };
});

const eslintConfig = defineConfig([
  ...withDebtWarned,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
