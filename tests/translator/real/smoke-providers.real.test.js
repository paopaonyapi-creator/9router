// REAL integration smoke test: sends a tiny prompt to EVERY provider that has an
// active credential in the local DB, through the full production path (handleChatCore).
// Gated by RUN_REAL=1 so the default `vitest run` never touches the network.
//
//   RUN_REAL=1 npx vitest run "tests/translator/real/"
//
// Each provider becomes its own test; providers without an llm model or without an
// active credential are skipped automatically.
import { describe, it, expect, beforeAll } from "vitest";
import { getProviderConnections } from "../../../src/lib/localDb.js";
import { getProviderCredentials } from "../../../src/sse/services/auth.js";
import { checkAndRefreshToken } from "../../../src/sse/services/tokenRefresh.js";
import { handleChatCore } from "../../../open-sse/handlers/chatCore.js";
import { getModelsByProviderId } from "../../../open-sse/config/providerModels.js";

const RUN_REAL = process.env.RUN_REAL === "1";
const MAX_TOKENS = 32;
const TIMEOUT_MS = 90000;
// Optional comma-separated filter: REAL_PROVIDERS=kiro,codex,antigravity
const PROVIDER_FILTER = (process.env.REAL_PROVIDERS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Pick the first plain llm model for a provider (skip image/tts/embedding/etc).
function firstLlmModel(providerId) {
  const models = getModelsByProviderId(providerId);
  const llm = models.find((m) => (m.type || "llm") === "llm");
  return llm?.id || null;
}

// Live gateway catalog grouped by model prefix (e.g. "maxplus/" -> ["glm-5.2", ...]).
// Lets REAL tests cover user-created compatible nodes that have no static registry entry.
// NOTE: cache the in-flight PROMISE (not the object) — concurrent tests must
// share one fetch, otherwise latecomers read an empty half-filled cache.
let gatewayCatalogPromise = null;
async function loadGatewayCatalog() {
  if (!gatewayCatalogPromise) gatewayCatalogPromise = fetchGatewayCatalog().catch(() => ({}));
  return gatewayCatalogPromise;
}
async function fetchGatewayCatalog() {
  const catalog = {};
  try {
    const { getApiKeys } = await import("../../../src/lib/localDb.js");
    const keys = await getApiKeys();
    const gwKey = keys.find((k) => k.isActive !== false)?.key;
    if (!gwKey) return catalog;
    const base = (process.env.GATEWAY_URL || "http://localhost:20128").replace(/\/$/, "");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${gwKey}` }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return catalog;
    for (const m of (await r.json()).data || []) {
      const slash = String(m.id || "").indexOf("/");
      if (slash <= 0) continue;
      (catalog[m.id.slice(0, slash)] ||= []).push(m.id.slice(slash + 1));
    }
  } catch (e) {
    console.warn(`[smoke] gateway catalog unavailable: ${e.message}`);
  }
  return catalog;
}

// Resolve a chat model for any active connection: static registry first,
// then the connection's defaultModel, then the live gateway catalog matched
// by node prefix (covers compatible nodes + ollama-local).
async function resolveModel(providerId) {
  const staticModel = firstLlmModel(providerId);
  if (staticModel) return staticModel;
  try {
    const { getProviderConnections, getProviderNodes } = await import("../../../src/lib/localDb.js");
    const conns = await getProviderConnections();
    const conn = conns.find((c) => c.provider === providerId && c.isActive !== false);
    if (!conn) return null;
    // rowToConn spreads the data JSON to top level (defaultModel, apiKey, …).
    if (conn.defaultModel) return conn.defaultModel;
    try {
      const def = typeof conn.data === "object"
        ? conn.data?.defaultModel
        : JSON.parse(conn.data || "{}").defaultModel;
      if (def) return def;
    } catch { /* ignore malformed data */ }
    const nodes = await getProviderNodes().catch(() => []);
    const prefix = nodes.find((n) => n.id === providerId)?.prefix
      || (providerId === "ollama-local" ? "ollama-local" : null);
    if (!prefix) return null;
    const catalog = await loadGatewayCatalog();
    return catalog[prefix]?.[0] || null;
  } catch {
    return null;
  }
}

// Drain the full Web Response SSE body into raw text.
async function drainSSE(response) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

let providerIds = [];

beforeAll(async () => {
  if (!RUN_REAL) return;
  providerIds = targetProviders();
});

describe.skipIf(!RUN_REAL).concurrent("REAL provider smoke", () => {
  it("has active providers in DB", () => {
    expect(providerIds.length).toBeGreaterThan(0);
  });

  // One concurrent test per provider; resolved lazily inside the test.
  for (const providerId of (RUN_REAL ? targetProviders() : [])) {
    it.concurrent(
      `${providerId}: responds to a short prompt`,
      async () => {
        const model = await resolveModel(providerId);
        if (!model) {
          console.warn(`[skip] ${providerId}: no llm model (registry/default/catalog)`);
          return expect(true).toBe(true);
        }

        const credentials = await getProviderCredentials(providerId, new Set(), model);
        if (!credentials || credentials.allRateLimited) {
          console.warn(`[skip] ${providerId}: no usable credential`);
          return expect(true).toBe(true);
        }

        const refreshed = await checkAndRefreshToken(providerId, credentials);
        const result = await handleChatCore({
          body: {
            model: `${providerId}/${model}`,
            stream: true,
            max_tokens: MAX_TOKENS,
            messages: [{ role: "user", content: "Reply with the single word: hi" }],
          },
          modelInfo: { provider: providerId, model },
          credentials: refreshed,
          connectionId: credentials.connectionId,
        });

        if (!result.success) {
          // Account/quota/auth problems are credential issues, not translation bugs → skip.
          const credIssue = [401, 402, 403, 429].includes(Number(result.status));
          if (credIssue) {
            console.warn(`[skip] ${providerId}: ${result.status} (credential/quota)`);
            return expect(true).toBe(true);
          }
          throw new Error(`${providerId} failed: ${result.status} ${result.error}`);
        }

        const raw = await drainSSE(result.response);
        // Minimal sanity: got SSE data and a terminal signal or content.
        expect(raw.length, `${providerId}: empty response`).toBeGreaterThan(0);
        expect(/data:|finish_reason|"delta"|"content"|event:/.test(raw), `${providerId}: not SSE`).toBe(true);
      },
      TIMEOUT_MS
    );
  }
});

// Read the DB file directly (sync) at module-eval time so vitest can generate one
// test per provider before beforeAll runs. Applies REAL_PROVIDERS filter.
// Tolerates any failure (returns []).
function targetProviders() {
  try {
    const Database = require("better-sqlite3");
    const os = require("os");
    const path = require("path");
    const dbPath = process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "db", "data.sqlite")
      : path.join(os.homedir(), ".9router", "db", "data.sqlite");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT DISTINCT provider FROM providerConnections WHERE isActive = 1").all();
    db.close();
    let list = rows.map((r) => r.provider).sort();
    if (PROVIDER_FILTER.length) list = list.filter((p) => PROVIDER_FILTER.includes(p));
    return list;
  } catch {
    return [];
  }
}
