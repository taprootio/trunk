import { SiteAuthoringError } from "./errors.js";

const QUOTE = "\"";

/**
 * A JSON parser that refuses a duplicated object key, shared by the
 * configuration and the machine settings (TR00645).
 *
 * `JSON.parse` silently keeps the last of two identical keys. For a file a
 * person can edit — and the settings file is one — that means the value the
 * file *visibly* declares first is not the value the CLI acts on: a settings
 * file with `apiBaseUrl` twice reads as production at the top and routes a
 * credential to local, or the reverse, and a `TAPROOT_SITE_KEY` would follow
 * it there. The only safe reading of an ambiguous target is to refuse it.
 *
 * Extracted from the configuration loader, which has needed the same guard
 * for `siteId` since it was written; parameterized on the two errors each
 * caller owns rather than copied, so there is one parser to review.
 */
export function parseJsonWithDuplicateGuard(text, { onDuplicate, onInvalid }) {
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = () => {
    if (text[offset] !== QUOTE) throw new Error("Expected a JSON string.");
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === QUOTE) {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (character === "\\") {
        offset += 1;
        if (text[offset] === "u") offset += 4;
      }
      offset += 1;
    }
    throw new Error("Unterminated JSON string.");
  };
  const value = (depth = 0) => {
    if (depth > 16) throw new Error("JSON nesting is too deep.");
    whitespace();
    if (text[offset] === QUOTE) return string();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const result = Object.create(null);
      const keys = new Set();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw onDuplicate(key);
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") throw new Error("Expected ':' after a JSON key.");
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") throw new Error("Expected ',' between JSON fields.");
        offset += 1;
      }
      throw new Error("Unterminated JSON object.");
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      const result = [];
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      while (offset < text.length) {
        result.push(value(depth + 1));
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return result;
        }
        if (text[offset] !== ",") throw new Error("Expected ',' between JSON values.");
        offset += 1;
      }
      throw new Error("Unterminated JSON array.");
    }
    const remaining = text.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(remaining)?.[0];
    if (!token) throw new Error("Invalid JSON value.");
    offset += token.length;
    return JSON.parse(token);
  };

  try {
    const parsed = value();
    whitespace();
    if (offset !== text.length) throw new Error("Unexpected data after the JSON value.");
    return parsed;
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    throw onInvalid();
  }
}
