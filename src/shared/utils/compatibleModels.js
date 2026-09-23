// Normalizes an upstream `/models` payload into `{ id, name }` pairs.
// Providers disagree on the envelope (`data` / `models` / bare array) and on the
// display-name key, so every /models reader funnels through here.
export function parseModels(data) {
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
