// Safety rails: last-active-key guard + defaultModel validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let ctx;

// NOTE: the db adapter is cached on globalThis and binds to the FIRST
// DATA_DIR it sees — one tempDir per file, wipe tables between tests.
async function setupDbOnce() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-safety-"));
  process.env.DATA_DIR = tempDir;
  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));
  const localDb = await import("@/lib/localDb.js");
  const keysRoute = await import("@/app/api/keys/[id]/route.js");
  const providersRoute = await import("@/app/api/providers/[id]/route.js");
  const delReq = () => new Request("https://9router.local/api/providers/x", { method: "DELETE" });
  ctx = { ...localDb, keysRoute, providersRoute, delReq };
}

async function wipeTables() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  db.run(`DELETE FROM apiKeys`);
  db.run(`DELETE FROM providerConnections`);
}

function cleanup() {
  // Windows: better-sqlite3 keeps the temp DB file locked until process
  // exit, so rmSync throws EPERM. Tolerate it; %TEMP% is OS-cleaned.
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "EPERM") throw err;
  }
}

describe("last active API key guard", () => {
  beforeEach(async () => {
    if (!ctx) await setupDbOnce();
    else await wipeTables();
  });
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  function req(method, body) {
    return new Request("https://9router.local/api/keys/x", {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it("DELETE refuses the last active key", async () => {
    const k = await ctx.createApiKey("only", "m1");
    const res = await ctx.keysRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: k.id }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last active/i);
    expect((await ctx.getApiKeys()).length).toBe(1);
  });

  it("DELETE allows when another active key remains", async () => {
    const k1 = await ctx.createApiKey("a", "m1");
    await ctx.createApiKey("b", "m1");
    const res = await ctx.keysRoute.DELETE(req("DELETE"), { params: Promise.resolve({ id: k1.id }) });
    expect(res.status).toBe(200);
    expect((await ctx.getApiKeys()).length).toBe(1);
  });

  it("PUT refuses pausing the last active key", async () => {
    const k = await ctx.createApiKey("only", "m1");
    const res = await ctx.keysRoute.PUT(req("PUT", { isActive: false }), { params: Promise.resolve({ id: k.id }) });
    expect(res.status).toBe(400);
    expect((await ctx.getApiKeyById(k.id)).isActive).not.toBe(false);
  });
});

describe("defaultModel validation", () => {
  let connId;
  beforeEach(async () => {
    if (!ctx) await setupDbOnce();
    else await wipeTables();
    const conn = await ctx.createProviderConnection({
      provider: "ollama-local",
      authType: "apikey",
      name: "t",
      apiKey: "x",
      isActive: true,
    });
    connId = conn.id;
  });

  function putReq(body) {
    return new Request("https://9router.local/api/providers/x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("PUT rejects model id with spaces", async () => {
    const res = await ctx.providersRoute.PUT(putReq({ defaultModel: "glm 5.3" }), { params: Promise.resolve({ id: connId }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/without spaces/i);
    expect((await ctx.getProviderConnectionById(connId)).defaultModel).not.toBe("glm 5.3");
  });

  it("PUT accepts and trims a valid model id", async () => {
    const res = await ctx.providersRoute.PUT(putReq({ defaultModel: "  glm-5.3  " }), { params: Promise.resolve({ id: connId }) });
    expect(res.status).toBe(200);
    expect((await ctx.getProviderConnectionById(connId)).defaultModel).toBe("glm-5.3");
  });
});

describe("last connection guard", () => {
  beforeEach(async () => {
    if (!ctx) await setupDbOnce();
    else await wipeTables();
  });

  async function addConn(name) {
    return ctx.createProviderConnection({
      provider: "ollama-local",
      authType: "apikey",
      name,
      apiKey: "x",
      isActive: true,
    });
  }

  it("DELETE refuses the last active connection", async () => {
    const c = await addConn("only");
    const res = await ctx.providersRoute.DELETE(ctx.delReq(), { params: Promise.resolve({ id: c.id }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/last active connection/i);
    expect(await ctx.getProviderConnectionById(c.id)).not.toBeNull();
  });

  it("DELETE allows when another active connection remains", async () => {
    const c1 = await addConn("a");
    await addConn("b");
    const res = await ctx.providersRoute.DELETE(ctx.delReq(), { params: Promise.resolve({ id: c1.id }) });
    expect(res.status).toBe(200);
    expect(await ctx.getProviderConnectionById(c1.id)).toBeNull();
  });
});

afterAll(() => {
  vi.doUnmock("next/server");
  vi.resetModules();
  vi.clearAllMocks();
  cleanup();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});
