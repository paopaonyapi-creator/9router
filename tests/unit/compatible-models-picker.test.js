// Picker endpoint: POST /api/providers/compatible-models lists upstream
// models for a node using a not-yet-saved key. Upstream fetch is stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let ctx;

async function setupOnce() {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compat-picker-"));
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
  const route = await import("@/app/api/providers/compatible-models/route.js");
  ctx = { ...localDb, route };
  await ctx.createProviderNode({
    id: "openai-compatible-chat-pickertest",
    type: "openai-compatible",
    name: "Picker Test",
    prefix: "pick",
    apiType: "chat",
    baseUrl: "https://models.test/v1",
  });
}

function postReq(body) {
  return new Request("https://9router.local/api/providers/compatible-models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/providers/compatible-models", () => {
  beforeAll(async () => {
    await setupOnce();
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("next/server");
    vi.resetModules();
    try {
      // Windows: sqlite handle lock → tolerate EPERM.
      fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    } catch (err) {
      if (err?.code !== "EPERM") throw err;
    }
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("400 without provider/apiKey", async () => {
    const res = await ctx.route.POST(postReq({ provider: "openai-compatible-chat-pickertest" }));
    expect(res.status).toBe(400);
  });

  it("404 for unknown node", async () => {
    const res = await ctx.route.POST(postReq({ provider: "openai-compatible-nope", apiKey: "k" }));
    expect(res.status).toBe(404);
  });

  it("lists models with Bearer auth for openai-compatible", async () => {
    const seen = {};
    vi.mocked(fetch).mockImplementation(async (url, opts) => {
      seen.url = url;
      seen.auth = opts.headers.Authorization;
      return { ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) };
    });
    const res = await ctx.route.POST(postReq({ provider: "openai-compatible-chat-pickertest", apiKey: "k" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(seen.url).toBe("https://models.test/v1/models");
    expect(seen.auth).toBe("Bearer k");
  });

  it("returns empty list (not throw) when upstream fails", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 });
    const res = await ctx.route.POST(postReq({ provider: "openai-compatible-chat-pickertest", apiKey: "bad" }));
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([]);
  });
});
