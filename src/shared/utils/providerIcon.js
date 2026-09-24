// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "ollama-search": "ollama",
};

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

// Custom nodes are keyed "<family>-compatible-<uuid>" (see OPENAI_COMPATIBLE_PREFIX /
// ANTHROPIC_COMPATIBLE_PREFIX in shared/constants/providers.js). No static logo exists
// for those ids, so every mount requested a file that can never exist. Map them back to
// the family icon instead.
const COMPATIBLE_FAMILY = /^(openai|anthropic)-compatible(?:-|$)/;

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  return providerId.trim().toLowerCase();
}

/** Static file a provider id should use, after family + alias mapping. */
function fileIdFor(raw) {
  const familyMatch = COMPATIBLE_FAMILY.exec(raw);
  const id = familyMatch ? familyMatch[1] : raw;
  return ICON_ALIASES[id] || id;
}

/** Resolve icon file id (after family + alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const raw = normalizeId(providerId);
  if (!raw) return "";
  const fileId = fileIdFor(raw);
  return failedIds.has(fileId) || failedIds.has(raw) ? "" : fileId;
}

/** `/providers/{id}.png` or null when previously failed. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  return id ? `/providers/${id}.png` : null;
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const raw = normalizeId(providerId);
  if (!raw) return;
  failedIds.add(raw);
  failedIds.add(fileIdFor(raw));
}
