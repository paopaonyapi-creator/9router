import { beforeEach, describe, expect, it, vi } from "vitest";

let getProviderIconSrc, markProviderIconMissing;

// failedIds is module-level session state, so each case needs a fresh module.
beforeEach(async () => {
  vi.resetModules();
  const mod = await import("@/shared/utils/providerIcon.js");
  getProviderIconSrc = mod.getProviderIconSrc;
  markProviderIconMissing = mod.markProviderIconMissing;
});

describe("getProviderIconSrc", () => {
  it("maps a custom node id back to its family logo", () => {
    expect(getProviderIconSrc("openai-compatible-chat-da49343c-e299-4f2c-bd1f-a652f2470942"))
      .toBe("/providers/openai.png");
    expect(getProviderIconSrc("anthropic-compatible-90967ee4-32f5-44ad-b004-26253de05fce"))
      .toBe("/providers/anthropic.png");
  });

  it("maps the bare compatible family too", () => {
    expect(getProviderIconSrc("openai-compatible")).toBe("/providers/openai.png");
  });

  it("is case and whitespace insensitive", () => {
    expect(getProviderIconSrc("  OpenAI-Compatible-ABC-123  ")).toBe("/providers/openai.png");
  });

  it("keeps the existing brand aliases resolving", () => {
    expect(getProviderIconSrc("gitlab-duo")).toBe("/providers/gitlab.png");
    expect(getProviderIconSrc("vercel-ai-gateway")).toBe("/providers/vercel.png");
    expect(getProviderIconSrc("perplexity-agent")).toBe("/providers/perplexity.png");
  });

  it("passes through a plain provider id", () => {
    expect(getProviderIconSrc("cursor")).toBe("/providers/cursor.png");
  });

  it("returns null for missing or non-string input", () => {
    expect(getProviderIconSrc(null)).toBeNull();
    expect(getProviderIconSrc("")).toBeNull();
    expect(getProviderIconSrc(undefined)).toBeNull();
    expect(getProviderIconSrc(42)).toBeNull();
  });

  it("stops requesting an id once it has 404ed, including its family", () => {
    markProviderIconMissing("openai-compatible-chat-abc-123");
    expect(getProviderIconSrc("openai-compatible-chat-abc-123")).toBeNull();
    // The family file is what actually failed, so other nodes of that family skip too.
    expect(getProviderIconSrc("openai")).toBeNull();
  });

  it("does not let one failed node suppress an unrelated provider", () => {
    markProviderIconMissing("anthropic-compatible-x-1");
    expect(getProviderIconSrc("cursor")).toBe("/providers/cursor.png");
    expect(getProviderIconSrc("openai-compatible-y-2")).toBe("/providers/openai.png");
  });
});
