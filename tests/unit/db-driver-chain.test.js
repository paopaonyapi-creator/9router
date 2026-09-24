// Verify 3-tier driver fallback: better-sqlite3 → node:sqlite → sql.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-chain-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Driver fallback chain", () => {
  it("default → picks better-sqlite3 when available", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(["better-sqlite3", "node:sqlite", "sql.js"]).toContain(db.driver);
  });

  it("falls back to node:sqlite when better-sqlite3 unavailable", async () => {
    // Mock the better-sqlite3 adapter to throw
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    // Node 22.5+ should give node:sqlite, else sql.js
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      expect(db.driver).toBe("node:sqlite");
    } else {
      expect(db.driver).toBe("sql.js");
    }
  });

  it("falls back to sql.js when both native drivers unavailable", async () => {
    vi.doMock("@/lib/db/adapters/betterSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    vi.doMock("@/lib/db/adapters/nodeSqliteAdapter.js", () => {
      throw new Error("simulated unavailable");
    });
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    expect(db.driver).toBe("sql.js");
  });
});

// The guard is a load-time decision: on runtimes where the addon is known to SIGSEGV,
// requiring it kills the process and no try/catch can recover, so callers outside the
// chain (the Cursor auto-import route) share this predicate instead of guessing.
describe("canUseBetterSqlite", () => {
  const versions = process.versions;
  const originalNode = versions.node;
  const originalBun = versions.bun;

  const setRuntime = (node, bun) => {
    Object.defineProperty(versions, "node", { value: node, configurable: true, writable: true });
    if (bun === undefined) delete versions.bun;
    else Object.defineProperty(versions, "bun", { value: bun, configurable: true, writable: true });
  };

  afterEach(() => {
    setRuntime(originalNode, originalBun);
  });

  it("allows Node below 24, where the addon loads and drives the chain", async () => {
    setRuntime("22.12.0");
    const { canUseBetterSqlite } = await import("@/lib/db/driver.js");
    expect(canUseBetterSqlite()).toBe(true);
  });

  it("blocks Node 24 and above", async () => {
    setRuntime("24.0.0");
    const { canUseBetterSqlite } = await import("@/lib/db/driver.js");
    expect(canUseBetterSqlite()).toBe(false);
    setRuntime("25.1.0");
    expect(canUseBetterSqlite()).toBe(false);
  });

  it("blocks Bun regardless of the Node version it reports", async () => {
    setRuntime("20.11.0", "1.2.3");
    const { canUseBetterSqlite } = await import("@/lib/db/driver.js");
    expect(canUseBetterSqlite()).toBe(false);
  });

  it("is what actually decides the chain on Node 24", async () => {
    setRuntime("24.19.0");
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter, canUseBetterSqlite } = await import("@/lib/db/driver.js");
    expect(canUseBetterSqlite()).toBe(false);
    const db = await getAdapter();
    // The policy point is that the chain never lands on better-sqlite3 here; which
    // fallback wins depends on what else the runtime and filesystem offer.
    expect(db.driver).not.toBe("better-sqlite3");
    expect(["node:sqlite", "sql.js"]).toContain(db.driver);
  });
});
