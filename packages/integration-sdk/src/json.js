export class DuplicateJsonKeyError extends Error {
  constructor(path, key) {
    super("JSON contains duplicate object keys.");
    this.name = "DuplicateJsonKeyError";
    this.path = path;
    this.key = key;
  }
}

function childPath(context) {
  if (!context) return [];
  return context.object ? [...context.path, context.key] : [...context.path, context.index];
}

/**
 * Rejects duplicate keys in every object before returning parsed JSON. JavaScript's JSON parser
 * keeps the last duplicate key, while the public Taproot contracts treat every object as closed.
 */
export function parseJsonWithoutDuplicateKeys(source) {
  const value = JSON.parse(source);
  const contexts = [];

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (++index; index < source.length; index++) {
        if (!escaped && source[index] === '"') break;
        escaped = !escaped && source[index] === "\\";
        if (escaped && source[index] !== "\\") escaped = false;
      }

      const context = contexts.at(-1);
      if (context?.object && context.expectingKey) {
        const key = JSON.parse(source.slice(start, index + 1));
        if (context.keys.has(key)) throw new DuplicateJsonKeyError(context.path, key);
        context.keys.add(key);
        context.key = key;
        context.expectingKey = false;
      }
    } else if (character === "{") {
      contexts.push({ object: true, expectingKey: true, key: undefined, keys: new Set(), path: childPath(contexts.at(-1)) });
    } else if (character === "[") {
      contexts.push({ object: false, index: 0, path: childPath(contexts.at(-1)) });
    } else if (character === "}" || character === "]") {
      contexts.pop();
    } else if (character === ",") {
      const context = contexts.at(-1);
      if (context?.object) context.expectingKey = true;
      else if (context) context.index++;
    }
  }

  return value;
}
