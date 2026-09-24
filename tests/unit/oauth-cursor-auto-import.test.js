import { join } from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

// Mock fs/promises
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Strategy 1 opens the db through a bare `require("better-sqlite3")`. That only
// resolves inside Next's webpack runtime — vitest's module scope has no `require`
// wired to the mock registry — so strategy 1 cannot be driven from here. Pin the
// "native bindings unavailable" outcome it degrades to and exercise the sqlite3 CLI
// strategy the route falls through to instead.
vi.mock("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw new Error("SQLITE_CANTOPEN: native bindings unavailable");
    }
  },
}));

const cp = vi.hoisted(() => ({
  calls: [],
  rows: {},
  whichCursor: true,
}));

// The route promisifies execFile at module load, so the fake has to answer in the
// (err, { stdout, stderr }) shape that promisify resolves with.
vi.mock("child_process", () => {
  const execFile = (cmd, args, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    cp.calls.push({ cmd, args });
    queueMicrotask(() => {
      if (cmd === "which") {
        return cp.whichCursor
          ? done(null, { stdout: "/usr/bin/cursor\n", stderr: "" })
          : done(new Error("which: no cursor"));
      }
      const sql = args?.[1] ?? "";
      const key = /key='([^']+)'/.exec(sql)?.[1];
      const value = key && key in cp.rows ? cp.rows[key] : "";
      done(null, { stdout: `${value}\n`, stderr: "" });
    });
  };
  return { execFile, default: { execFile } };
});

let GET;

const macPaths = [
  join("/mock/home", "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
  join("/mock/home", "Library/Application Support/Cursor - Insiders/User/globalStorage/state.vscdb"),
];

const linuxPaths = [
  join("/mock/home", ".config/Cursor/User/globalStorage/state.vscdb"),
  join("/mock/home", ".config/cursor/User/globalStorage/state.vscdb"),
];

function allPathsAccessible() {
  vi.mocked(fsPromises.access).mockResolvedValue(undefined);
}

function sqliteCalls() {
  return cp.calls.filter((call) => call.cmd === "sqlite3");
}

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    cp.calls.length = 0;
    cp.rows = {
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    };
    cp.whichCursor = true;
    vi.mocked(fsPromises.access).mockReset();
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));
    // Force darwin so macOS-specific logic is exercised
    Object.defineProperty(process, "platform", { value: "darwin", writable: true, configurable: true });
    // Re-import so the module picks up the promisified execFile mock again
    vi.resetModules();
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true, configurable: true });
    vi.unstubAllEnvs();
  });

  // ── path probing ──────────────────────────────────────────────────────

  it("lists every probed macOS location when none is accessible", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    for (const candidate of macPaths) {
      expect(response.body.error).toContain(candidate);
    }
  });

  it("uses the first accessible candidate and reports it when no tokens are found", async () => {
    vi.mocked(fsPromises.access).mockImplementation(async (path) => {
      if (path === macPaths[1]) return undefined;
      throw new Error("ENOENT");
    });
    cp.rows = {};

    const response = await GET();

    expect(response.body).toEqual({ found: false, windowsManual: true, dbPath: macPaths[1] });
  });

  // ── token extraction (sqlite3 CLI strategy) ───────────────────────────

  it("extracts tokens using the exact keys", async () => {
    allPathsAccessible();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");

    const sql = sqliteCalls().map((call) => call.args[1]);
    expect(sql.some((query) => query.includes("key='cursorAuth/accessToken'"))).toBe(true);
    expect(sql.some((query) => query.includes("key='storage.serviceMachineId'"))).toBe(true);
    // Queries run against the discovered db, not a hardcoded path.
    expect(sqliteCalls()[0].args[0]).toBe(macPaths[0]);
  });

  it("falls back to the alternate token and machine-id keys", async () => {
    allPathsAccessible();
    cp.rows = {
      "cursorAuth/token": "alt-token",
      "telemetry.machineId": "alt-machine-id",
    };

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("alt-token");
    expect(response.body.machineId).toBe("alt-machine-id");
  });

  it("unwraps JSON-encoded string values", async () => {
    allPathsAccessible();
    cp.rows = {
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    };

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("degrades to the manual-paste response when the db holds no tokens", async () => {
    allPathsAccessible();
    cp.rows = {};

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ found: false, windowsManual: true, dbPath: macPaths[0] });
  });

  it("degrades to the manual-paste response when only one of the two tokens exists", async () => {
    allPathsAccessible();
    cp.rows = { "cursorAuth/accessToken": "test-token" };

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── platform behaviour ────────────────────────────────────────────────

  it("probes the APPDATA and LOCALAPPDATA candidates on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true, configurable: true });
    vi.stubEnv("APPDATA", join("/mock/home", "AppData/Roaming"));
    vi.stubEnv("LOCALAPPDATA", join("/mock/home", "AppData/Local"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(
      join("/mock/home", "AppData/Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
    expect(response.body.error).toContain(
      join("/mock/home", "AppData/Local", "Programs", "Cursor", "User", "globalStorage", "state.vscdb"),
    );
  });

  it("skips auto-import on linux when Cursor is not actually installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    cp.whichCursor = false;
    // The db is there, but neither `which cursor` nor the .desktop entry is.
    vi.mocked(fsPromises.access).mockImplementation(async (path) => {
      if (String(path).endsWith("state.vscdb")) return undefined;
      throw new Error("ENOENT");
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
    expect(cp.calls.some((call) => call.cmd === "which")).toBe(true);
    expect(sqliteCalls()).toHaveLength(0);
  });

  it("extracts tokens on linux once Cursor is installed", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true, configurable: true });
    allPathsAccessible();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(sqliteCalls()[0].args[0]).toBe(linuxPaths[0]);
  });

  it("treats an unknown platform like the linux config paths instead of rejecting it", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true, configurable: true });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(linuxPaths[1]);
  });
});
