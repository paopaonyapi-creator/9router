import { NextResponse } from "next/server";
import { getProviderNodeById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

const FETCH_TIMEOUT_MS = 10000;

function parseModels(data) {
  const raw = Array.isArray(data) ? data : data?.data || data?.models || [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const id = m?.id || m?.name || m?.model;
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: m?.display_name || m?.displayName || m?.name || id });
  }
  return out;
}

// POST /api/providers/compatible-models — list models for a compatible node
// using a not-yet-saved API key (used by the connection modals' model picker).
// Body: { provider: <node id>, apiKey }. Never logs the key.
export async function POST(request) {
  try {
    const body = await request.json();
    const { provider, apiKey } = body || {};
    if (!provider || !apiKey) {
      return NextResponse.json({ error: "provider and apiKey are required" }, { status: 400 });
    }
    if (!isOpenAICompatibleProvider(provider) && !isAnthropicCompatibleProvider(provider)) {
      return NextResponse.json({ error: "Not a compatible provider node" }, { status: 400 });
    }

    const node = await getProviderNodeById(provider);
    const baseUrl = node?.baseUrl?.trim?.().replace(/\/$/, "");
    if (!node || !baseUrl) {
      return NextResponse.json({ error: "Compatible node not found or missing base URL" }, { status: 404 });
    }

    let url = `${baseUrl}/models`;
    const headers = { "Content-Type": "application/json" };
    if (isOpenAICompatibleProvider(provider)) {
      headers.Authorization = `Bearer ${apiKey}`;
    } else {
      if (url.endsWith("/messages/models")) url = url.slice(0, -9);
      else if (url.endsWith("/messages")) url = `${url.slice(0, -9)}/models`;
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { method: "GET", headers, cache: "no-store", signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return NextResponse.json({ error: `Upstream returned ${response.status}`, models: [] }, { status: 200 });
    }
    return NextResponse.json({ models: parseModels(await response.json().catch(() => null)) });
  } catch (error) {
    console.log("Error fetching compatible models:", error?.message || error);
    return NextResponse.json({ error: "Failed to fetch models", models: [] }, { status: 200 });
  }
}
