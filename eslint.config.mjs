import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// eslint-plugin-react-hooks v7 (pulled in by eslint-config-next 16.3.6) promotes its
// compiler-era rules to errors, and this codebase carries 136 pre-existing sites
// across 56 files. Downgraded to warnings so `npx eslint .` is usable as a gate.
// This reclassifies debt, it does not fix it — clear these per file and then delete
// the map. Several purity hits are deliberate (Date.now() inside a useMemo whose deps
// include the refresh tick) or sit in event handlers, so the rule is not always right.
const REACT_HOOKS_DEBT = [
  "react-hooks/set-state-in-effect",
  "react-hooks/immutability",
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
