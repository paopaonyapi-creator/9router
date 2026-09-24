import { beforeEach, describe, expect, it, vi } from "vitest";

// agent.api5.cursor.sh is HTTP/2-only, so cursorModels rides node:http2 rather than
// fetch — stubbing global.fetch lets the real request escape to the network.
const h2 = vi.hoisted(() => ({
  status: 200,
  body: null,
  connectError: null,
  urls: [],
  requests: [],
  bodies: [],
  closed: 0,
}));

vi.mock("http2", () => {
  const connect = (url) => {
    h2.urls.push(url);
    return {
      on(event, fn) {
        if (event === "error" && h2.connectError) {
          queueMicrotask(() => fn(new Error(h2.connectError)));
        }
      },
      close() {
        h2.closed += 1;
      },
      request(headers) {
        h2.requests.push(headers);
        const reqHandlers = {};
        const req = {
          on(event, fn) {
            (reqHandlers[event] ||= []).push(fn);
            return req;
          },
          end(body) {
            h2.bodies.push(body);
            queueMicrotask(() => {
              const emit = (event, ...args) => (reqHandlers[event] || []).forEach((fn) => fn(...args));
              if (h2.connectError) return emit("error", new Error(h2.connectError));
              emit("response", { ":status": h2.status });
              if (h2.body?.length) emit("data", Buffer.from(h2.body));
              emit("end");
            });
          },
        };
        return req;
      },
    };
  };
  return { default: { connect }, connect };
});

const {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} = await import("../../open-sse/services/cursorModels.js");

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

const credentials = {
  accessToken: "cursor-token",
  providerSpecificData: { machineId: "machine-id" },
};

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.status = 200;
    h2.body = null;
    h2.connectError = null;
    h2.urls.length = 0;
    h2.requests.length = 0;
    h2.bodies.length = 0;
    h2.closed = 0;
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog over h2 and caches it", async () => {
    h2.body = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2.urls).toEqual(["https://agent.api5.cursor.sh"]);
    expect(h2.requests).toHaveLength(1);
    expect(h2.requests[0]).toMatchObject({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      ":authority": "agent.api5.cursor.sh",
      ":scheme": "https",
      accept: "application/proto",
      "content-type": "application/proto",
      authorization: "Bearer cursor-token",
    });
    // Unary Connect calls must not carry the streaming Connect headers.
    expect(h2.requests[0]).not.toHaveProperty("connect-accept-encoding");
    expect(h2.requests[0]).not.toHaveProperty("connect-protocol-version");
    // The request payload is an empty protobuf, which http2 sends as no body at all.
    expect(h2.bodies[0]).toBeUndefined();
    expect(h2.closed).toBe(1);
  });

  it("fails open when the Cursor catalog request returns an error status", async () => {
    h2.status = 403;
    h2.body = text("no");

    await expect(resolveCursorModels(credentials)).resolves.toBeNull();
  });

  it("fails open when the h2 transport errors", async () => {
    h2.connectError = "ECONNRESET";

    await expect(resolveCursorModels(credentials)).resolves.toBeNull();
  });

  it("skips the live fetch without an access token and machine id", async () => {
    await expect(resolveCursorModels({ accessToken: "cursor-token" })).resolves.toBeNull();
    expect(h2.urls).toEqual([]);
  });
});
