/** Extract the first top-level JSON object from model text (tolerates code fences and preamble). */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object in response");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}" && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in response");
}
