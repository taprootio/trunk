import { LIMITS } from "./constants.js";
import { classifyBinaryInput, snapshotBinaryInput } from "./binary.js";
import { sanitizeValidationError } from "./errors.js";

class StrictJsonError extends Error {
  constructor(code, message, path = "$") {
    super(message);
    this.code = code;
    this.path = path;
  }
}

class StrictJsonParser {
  constructor(text, maximumDepth = LIMITS.manifestObjectDepth) {
    this.text = text;
    this.offset = 0;
    this.maximumDepth = maximumDepth;
  }

  parse() {
    this.#skipWhitespace();
    const value = this.#parseValue("$", 0);
    this.#skipWhitespace();
    if (this.offset !== this.text.length) {
      throw new StrictJsonError("json.invalid", `Unexpected content at offset ${this.offset}.`);
    }
    return value;
  }

  #parseValue(path, depth) {
    if (depth > this.maximumDepth) {
      throw new StrictJsonError("json.too_deep", `JSON nesting may not exceed ${this.maximumDepth} levels.`, path);
    }
    const char = this.text[this.offset];
    if (char === "{") return this.#parseObject(path, depth + 1);
    if (char === "[") return this.#parseArray(path, depth + 1);
    if (char === '"') return this.#parseString(path);
    if (char === "t" && this.text.startsWith("true", this.offset)) {
      this.offset += 4;
      return true;
    }
    if (char === "f" && this.text.startsWith("false", this.offset)) {
      this.offset += 5;
      return false;
    }
    if (char === "n" && this.text.startsWith("null", this.offset)) {
      this.offset += 4;
      return null;
    }
    if (char === "-" || (char >= "0" && char <= "9")) return this.#parseNumber(path);
    throw new StrictJsonError("json.invalid", `Expected a JSON value at offset ${this.offset}.`, path);
  }

  #parseObject(path, depth) {
    this.offset += 1;
    const object = Object.create(null);
    const keys = new Set();
    this.#skipWhitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return object;
    }

    while (this.offset < this.text.length) {
      if (this.text[this.offset] !== '"') {
        throw new StrictJsonError("json.invalid", `Expected an object key at offset ${this.offset}.`, path);
      }
      const key = this.#parseString(path);
      const childPath = `${path}.${key}`;
      if (keys.has(key)) {
        throw new StrictJsonError("json.duplicate_key", `Duplicate JSON object key '${key}'.`, childPath);
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.text[this.offset] !== ":") {
        throw new StrictJsonError("json.invalid", `Expected ':' after object key at offset ${this.offset}.`, childPath);
      }
      this.offset += 1;
      this.#skipWhitespace();
      object[key] = this.#parseValue(childPath, depth);
      this.#skipWhitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return object;
      }
      if (delimiter !== ",") {
        throw new StrictJsonError("json.invalid", `Expected ',' or '}' at offset ${this.offset}.`, path);
      }
      this.offset += 1;
      this.#skipWhitespace();
    }
    throw new StrictJsonError("json.invalid", "Unterminated JSON object.", path);
  }

  #parseArray(path, depth) {
    this.offset += 1;
    const values = [];
    this.#skipWhitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return values;
    }

    while (this.offset < this.text.length) {
      values.push(this.#parseValue(`${path}[${values.length}]`, depth));
      this.#skipWhitespace();
      const delimiter = this.text[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return values;
      }
      if (delimiter !== ",") {
        throw new StrictJsonError("json.invalid", `Expected ',' or ']' at offset ${this.offset}.`, path);
      }
      this.offset += 1;
      this.#skipWhitespace();
    }
    throw new StrictJsonError("json.invalid", "Unterminated JSON array.", path);
  }

  #parseString(path) {
    this.offset += 1;
    let value = "";
    while (this.offset < this.text.length) {
      const char = this.text[this.offset];
      if (char === '"') {
        this.offset += 1;
        return value;
      }
      if (char.charCodeAt(0) < 0x20) {
        throw new StrictJsonError("json.invalid", `Unescaped control character at offset ${this.offset}.`, path);
      }
      if (char !== "\\") {
        value += char;
        this.offset += 1;
        continue;
      }

      this.offset += 1;
      const escape = this.text[this.offset];
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (Object.hasOwn(simple, escape)) {
        value += simple[escape];
        this.offset += 1;
        continue;
      }
      if (escape !== "u") {
        throw new StrictJsonError("json.invalid", `Invalid string escape at offset ${this.offset}.`, path);
      }
      const first = this.#parseUnicodeEscape(path);
      if (first >= 0xd800 && first <= 0xdbff) {
        if (this.text[this.offset] !== "\\" || this.text[this.offset + 1] !== "u") {
          throw new StrictJsonError("json.invalid_unicode", "High surrogate must be followed by a low surrogate.", path);
        }
        this.offset += 1;
        const second = this.#parseUnicodeEscape(path);
        if (second < 0xdc00 || second > 0xdfff) {
          throw new StrictJsonError("json.invalid_unicode", "High surrogate must be followed by a low surrogate.", path);
        }
        value += String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        throw new StrictJsonError("json.invalid_unicode", "A low surrogate cannot appear without a high surrogate.", path);
      } else {
        value += String.fromCharCode(first);
      }
    }
    throw new StrictJsonError("json.invalid", "Unterminated JSON string.", path);
  }

  #parseUnicodeEscape(path) {
    this.offset += 1;
    const hex = this.text.slice(this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
      throw new StrictJsonError("json.invalid_unicode", `Invalid Unicode escape at offset ${this.offset}.`, path);
    }
    this.offset += 4;
    return Number.parseInt(hex, 16);
  }

  #parseNumber(path) {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(this.text.slice(this.offset));
    if (!match) {
      throw new StrictJsonError("json.invalid", `Invalid number at offset ${this.offset}.`, path);
    }
    this.offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) {
      throw new StrictJsonError("json.invalid_number", "JSON numbers must be finite.", path);
    }
    return number;
  }

  #skipWhitespace() {
    while (this.offset < this.text.length && /[\u0009\u000a\u000d\u0020]/u.test(this.text[this.offset])) {
      this.offset += 1;
    }
  }
}

export function classifyManifestInput(input) {
  if (typeof input === "string") return { kind: "string" };
  if (input === null || (typeof input !== "object" && typeof input !== "function")) return { kind: "other" };
  const binary = classifyBinaryInput(input);
  if (binary.kind !== "other") return binary;
  try {
    Object.getPrototypeOf(input);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "object" };
}

function asBytes(input, classification = classifyManifestInput(input), maximumBytes = LIMITS.manifestBytes) {
  if (typeof input === "string") {
    if (input.length > maximumBytes) {
      throw new StrictJsonError("manifest.too_large", `Manifest bytes may not exceed ${maximumBytes}.`);
    }
    let byteLength = 0;
    for (let offset = 0; offset < input.length; offset += 1) {
      const first = input.charCodeAt(offset);
      if (first >= 0xd800 && first <= 0xdbff) {
        const second = input.charCodeAt(offset + 1);
        if (second < 0xdc00 || second > 0xdfff) {
          throw new StrictJsonError("json.invalid_unicode", "Manifest text must contain only well-formed Unicode scalar values.");
        }
        byteLength += 4;
        offset += 1;
      } else if (first >= 0xdc00 && first <= 0xdfff) {
        throw new StrictJsonError("json.invalid_unicode", "Manifest text must contain only well-formed Unicode scalar values.");
      } else {
        byteLength += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
      }
      if (byteLength > maximumBytes) {
        throw new StrictJsonError("manifest.too_large", `Manifest bytes may not exceed ${maximumBytes}.`);
      }
    }
    return new TextEncoder().encode(input);
  }
  if (classification.kind === "uint8array" || classification.kind === "arraybuffer") {
    const snapshot = snapshotBinaryInput(input, maximumBytes, classification);
    if (snapshot.kind === "too_large") {
      throw new StrictJsonError("manifest.too_large", `Manifest bytes may not exceed ${maximumBytes}.`);
    }
    if (snapshot.kind === "bytes") return snapshot.bytes;
  }
  throw new TypeError("Manifest input must be a string, Uint8Array, or ArrayBuffer.");
}

export function parseManifestJson(
  input,
  classification = classifyManifestInput(input),
  maximumBytes = LIMITS.manifestBytes,
  maximumDepth = LIMITS.manifestObjectDepth,
) {
  let bytes;
  try {
    bytes = asBytes(input, classification, maximumBytes);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return { ok: false, errors: [sanitizeValidationError(error)] };
    }
    return { ok: false, errors: [sanitizeValidationError({ code: "json.invalid_input", path: "$", message: error.message })] };
  }
  if (bytes.byteLength > maximumBytes) {
    return {
      ok: false,
      errors: [sanitizeValidationError({
        code: "manifest.too_large",
        path: "$",
        message: `Manifest bytes may not exceed ${maximumBytes}.`,
      })],
    };
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, errors: [sanitizeValidationError({ code: "json.invalid_utf8", path: "$", message: "Manifest bytes must be valid UTF-8." })] };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    return { ok: false, errors: [sanitizeValidationError({ code: "json.bom", path: "$", message: "Manifest JSON must not start with a byte-order mark." })] };
  }

  try {
    return { ok: true, value: new StrictJsonParser(text, maximumDepth).parse() };
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return { ok: false, errors: [sanitizeValidationError(error)] };
    }
    throw error;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function utf8Length(value) {
  let bytes = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function canonicalJsonByteLength(value, maximumBytes = Number.MAX_SAFE_INTEGER) {
  let bytes = 0;
  const add = (count) => {
    bytes += count;
    return bytes <= maximumBytes;
  };
  const visit = (candidate, depth) => {
    if (Array.isArray(candidate)) {
      if (candidate.length === 0) return add(2);
      if (!add(2)) return false;
      for (let index = 0; index < candidate.length; index += 1) {
        if (!add((depth + 1) * 2) || !visit(candidate[index], depth + 1)) return false;
        if (!add(index + 1 < candidate.length ? 2 : 1)) return false;
      }
      return add((depth * 2) + 1);
    }
    if (candidate !== null && typeof candidate === "object") {
      const keys = Object.keys(candidate).sort();
      if (keys.length === 0) return add(2);
      if (!add(2)) return false;
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const encodedKey = JSON.stringify(key);
        if (!add(((depth + 1) * 2) + utf8Length(encodedKey) + 2) || !visit(candidate[key], depth + 1)) return false;
        if (!add(index + 1 < keys.length ? 2 : 1)) return false;
      }
      return add((depth * 2) + 1);
    }
    return add(utf8Length(JSON.stringify(candidate)));
  };
  visit(value, 0);
  if (bytes <= maximumBytes) add(1);
  return bytes > maximumBytes ? maximumBytes + 1 : bytes;
}

class ManifestObjectPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const OMITTED_JSON_VALUE = Symbol("taproot.docs.omittedJsonValue");

function jsonStringByteLength(value, maximumBytes) {
  let bytes = 2;
  for (let offset = 0; offset < value.length; offset += 1) {
    const first = value.charCodeAt(offset);
    if (first === 0x22 || first === 0x5c || first === 0x08 || first === 0x09 || first === 0x0a || first === 0x0c || first === 0x0d) {
      bytes += 2;
    } else if (first <= 0x1f || (first >= 0xd800 && first <= 0xdfff)) {
      if (first >= 0xd800 && first <= 0xdbff) {
        const second = value.charCodeAt(offset + 1);
        if (second >= 0xdc00 && second <= 0xdfff) {
          bytes += 4;
          offset += 1;
        } else {
          bytes += 6;
        }
      } else {
        bytes += 6;
      }
    } else {
      bytes += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
    }
    if (bytes > maximumBytes) return maximumBytes + 1;
  }
  return bytes;
}

export function preflightManifestObject(value, limits = {}) {
  const maximumBytes = limits.manifestBytes ?? LIMITS.manifestBytes;
  const maximumWork = limits.manifestObjectWork ?? LIMITS.manifestObjectWork;
  const maximumDepth = limits.manifestObjectDepth ?? LIMITS.manifestObjectDepth;
  const stopAtByteLimit = limits.stopAtByteLimit === true;
  const visiting = new WeakSet();
  const cachedSubtrees = new WeakMap();
  const state = { work: 0 };
  const byteLimitError = () => new ManifestObjectPreflightError(
    "manifest.too_large",
    `Canonical manifest bytes may not exceed ${maximumBytes}.`,
  );
  const checkByteLimit = (bytes) => {
    if (stopAtByteLimit && bytes > maximumBytes) throw byteLimitError();
    return Math.min(maximumBytes + 1, bytes);
  };
  const add = (left, right) => checkByteLimit(left + right);
  const consumeWork = (logicalWork = 1) => {
    state.work += logicalWork;
    if (state.work > maximumWork) {
      throw new ManifestObjectPreflightError(
        "manifest.too_large",
        `Manifest object validation work may not exceed ${maximumWork} values.`,
      );
    }
  };
  const visit = (candidate, depth) => {
    if (typeof candidate === "string") {
      consumeWork();
      return {
        bytes: jsonStringByteLength(candidate, maximumBytes),
        logicalWork: 1,
        relativeDepth: -1,
        snapshot: candidate,
      };
    }
    if (candidate === null || typeof candidate !== "object") {
      consumeWork();
      if (typeof candidate === "bigint") {
        throw new ManifestObjectPreflightError("manifest.invalid_graph", "Manifest object values must use JSON-compatible types.");
      }
      if (["undefined", "function", "symbol"].includes(typeof candidate)) {
        return { bytes: 0, logicalWork: 1, relativeDepth: -1, snapshot: OMITTED_JSON_VALUE };
      }
      const encoded = JSON.stringify(candidate);
      const snapshot = typeof candidate === "number" && !Number.isFinite(candidate)
        ? null
        : Object.is(candidate, -0)
        ? 0
        : candidate;
      return { bytes: encoded.length, logicalWork: 1, relativeDepth: -1, snapshot };
    }
    if (visiting.has(candidate)) {
      throw new ManifestObjectPreflightError("manifest.cyclic", "Manifest objects may not contain cyclic references.");
    }
    const cached = cachedSubtrees.get(candidate);
    if (cached !== undefined) {
      if (depth + cached.relativeDepth > maximumDepth) {
        throw new ManifestObjectPreflightError(
          "manifest.object_too_deep",
          `Manifest object nesting may not exceed ${maximumDepth} levels.`,
        );
      }
      consumeWork(cached.logicalWork);
      return cached;
    }
    if (depth > maximumDepth) {
      throw new ManifestObjectPreflightError(
        "manifest.object_too_deep",
        `Manifest object nesting may not exceed ${maximumDepth} levels.`,
      );
    }
    const workAtStart = state.work;
    consumeWork();
    visiting.add(candidate);
    let bytes = 2;
    let relativeDepth = 0;
    let snapshot;
    if (Array.isArray(candidate)) {
      const length = Reflect.get(candidate, "length");
      if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) {
        throw new ManifestObjectPreflightError("manifest.invalid_graph", "Manifest arrays must have a valid JSON length.");
      }
      snapshot = new Array(length);
      for (let index = 0; index < length; index += 1) {
        if (index > 0) bytes = add(bytes, 1);
        const key = String(index);
        const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
        if (descriptor !== undefined) {
          const child = visit(Reflect.get(candidate, key), depth + 1);
          bytes = add(bytes, child.bytes);
          relativeDepth = Math.max(relativeDepth, child.relativeDepth + 1);
          snapshot[index] = child.snapshot === OMITTED_JSON_VALUE ? null : child.snapshot;
        } else {
          consumeWork();
          bytes = add(bytes, 4);
          snapshot[index] = null;
        }
      }
    } else {
      snapshot = Object.create(null);
      let first = true;
      for (const key of Object.keys(candidate)) {
        if (stopAtByteLimit) {
          let minimumBytes = bytes;
          if (!first) minimumBytes = add(minimumBytes, 1);
          minimumBytes = add(minimumBytes, jsonStringByteLength(key, maximumBytes));
          add(minimumBytes, 1);
        }
        const child = visit(Reflect.get(candidate, key), depth + 1);
        if (child.snapshot === OMITTED_JSON_VALUE) continue;
        if (!first) bytes = add(bytes, 1);
        first = false;
        bytes = add(bytes, jsonStringByteLength(key, maximumBytes));
        bytes = add(bytes, 1);
        bytes = add(bytes, child.bytes);
        relativeDepth = Math.max(relativeDepth, child.relativeDepth + 1);
        snapshot[key] = child.snapshot;
      }
    }
    visiting.delete(candidate);
    const result = {
      bytes,
      logicalWork: state.work - workAtStart,
      relativeDepth,
      snapshot,
    };
    cachedSubtrees.set(candidate, result);
    return result;
  };

  try {
    const result = visit(value, 0);
    return {
      ok: true,
      exceedsByteLimit: result.bytes > maximumBytes,
      value: result.snapshot === OMITTED_JSON_VALUE ? undefined : result.snapshot,
    };
  } catch (error) {
    if (error instanceof ManifestObjectPreflightError) {
      return { ok: false, errors: [sanitizeValidationError({ code: error.code, path: "$", message: error.message })] };
    }
    return {
      ok: false,
      errors: [sanitizeValidationError({
        code: "manifest.invalid_graph",
        path: "$",
        message: "Manifest object properties could not be traversed safely.",
      })],
    };
  }
}
