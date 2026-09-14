import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array. Text-only parts without cache_control
// become a plain string (Ollama and other strict OpenAI gateways reject a
// text-part array via oneOf). Mixed / cached parts stay as an array so
// DashScope-style cache_control markers survive.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  const canJoin = parts.every(
    (part) => part && part.type === OPENAI_BLOCK.TEXT && !part.cache_control
  );
  if (canJoin) {
    return parts.map((part) => part.text || "").join("\n");
  }
  return parts;
}
