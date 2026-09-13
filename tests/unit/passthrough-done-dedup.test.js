// Passthrough streams must not emit two `data: [DONE]` sentinels.
// Upstream OpenAI-compatible providers (e.g. Ollama) terminate their own SSE
// with [DONE]; createSSEStream forwards it verbatim in passthrough mode, and
// flush() used to append a second sentinel because `streamDoneSent` was only
// ever set in translate mode. Strict clients treat the duplicate as garbage
// frames after the terminal event.

import { describe, it, expect } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function drainPassthrough(upstreamChunks) {
  const res = sseResponse(upstreamChunks);
  const transformed = res.body.pipeThrough(
    createPassthroughStreamWithLogger("ollama-local", null, "test-model", null, { messages: [] }, null, null)
  );
  const text = await new Response(transformed).text();
  return text;
}

describe("passthrough [DONE] dedup", () => {
  it("forwards exactly one [DONE] when upstream already sent it", async () => {
    const out = await drainPassthrough([
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const doneCount = out.split("\n").filter((l) => l.trim() === "data: [DONE]").length;
    expect(doneCount).toBe(1);
    // The forwarded sentinel must be the last data frame.
    const lines = out.split("\n").filter((l) => l.trim());
    expect(lines[lines.length - 1]).toBe("data: [DONE]");
  });

  it("synthesizes one [DONE] when upstream never sends it", async () => {
    const out = await drainPassthrough([
      'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"yo"},"finish_reason":null}]}\n\n',
      'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
    ]);

    const doneCount = out.split("\n").filter((l) => l.trim() === "data: [DONE]").length;
    expect(doneCount).toBe(1);
  });

  it("tolerates data:[DONE] without a space from upstream", async () => {
    const out = await drainPassthrough([
      'data: {"id":"3","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      "data:[DONE]\n\n",
    ]);

    const doneCount = out.split("\n").filter((l) => l.trim() === "data: [DONE]").length;
    expect(doneCount).toBe(1);
  });
});
