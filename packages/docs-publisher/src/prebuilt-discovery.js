import { SaxesParser } from "saxes";
import { prebuiltFileRoute } from "@taprootio/docs-artifact/prebuilt";

const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_XML_TOKENS = 75_000;
const MAX_XML_DEPTH = 64;
const MAX_XML_NAMESPACES = 128;
const MAX_HTML_TOKENS = 10_000;
const MAX_SITEMAP_URLS = 25_000;
const MAX_DIAGNOSTICS = 100;

function diagnostic(code, path, message) {
  return Object.freeze({ code, path, message });
}

function boundedPush(target, value) {
  if (target.length < MAX_DIAGNOSTICS) target.push(value);
}

function decodeUtf8(content) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

function inspectTextFile(file, path, errors) {
  if (file === undefined) return undefined;
  if (file.content.byteLength > MAX_TEXT_BYTES) {
    boundedPush(errors, diagnostic("text.too_large", path, "The discovery file exceeds the bounded inspection limit."));
    return undefined;
  }
  const text = decodeUtf8(file.content);
  if (text === undefined) {
    boundedPush(errors, diagnostic("text.invalid_utf8", path, "The discovery file is not valid UTF-8."));
  }
  return text;
}

function validateProductionOrigin(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 2_000) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== ""
    || url.pathname !== "/" || url.search !== "" || url.hash !== "" || value !== url.origin
  ) return undefined;
  return url.origin;
}

function routeInventory(manifest, contents) {
  const files = new Map();
  for (const descriptor of manifest.files) {
    const route = prebuiltFileRoute(descriptor.path);
    if (route.ok) files.set(route.value, { ...descriptor, content: contents.get(descriptor.path)?.content });
  }
  return {
    files,
    redirects: new Set(manifest.redirects.map((redirect) => redirect.from)),
  };
}

function readXmlTag(input, offset) {
  let index = offset + 1;
  let quote = "";
  while (index < input.length) {
    const character = input[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return { text: input.slice(offset, index + 1), end: index + 1 };
    }
    index += 1;
  }
  return undefined;
}

function parseXmlTag(raw) {
  if (!raw.startsWith("<") || !raw.endsWith(">")) return undefined;
  let body = raw.slice(1, -1).trim();
  if (body.startsWith("/")) {
    const name = body.slice(1).trim();
    return /^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(name) ? { kind: "close", name } : undefined;
  }
  const selfClosing = body.endsWith("/");
  if (selfClosing) body = body.slice(0, -1).trimEnd();
  const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(body);
  if (!match) return undefined;
  const attributes = new Map();
  let offset = 0;
  const tail = match[2] ?? "";
  while (offset < tail.length) {
    while (/\s/u.test(tail[offset] ?? "")) offset += 1;
    if (offset >= tail.length) break;
    const attribute = /^([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(tail.slice(offset));
    if (!attribute) return undefined;
    const name = attribute[1];
    offset += name.length;
    while (/\s/u.test(tail[offset] ?? "")) offset += 1;
    if (tail[offset] !== "=") return undefined;
    offset += 1;
    while (/\s/u.test(tail[offset] ?? "")) offset += 1;
    const quote = tail[offset];
    if (quote !== "\"" && quote !== "'") return undefined;
    offset += 1;
    const end = tail.indexOf(quote, offset);
    if (end < 0) return undefined;
    if (attributes.has(name)) return undefined;
    attributes.set(name, tail.slice(offset, end));
    offset = end + 1;
  }
  return { kind: "open", name: match[1], attributes, selfClosing };
}

function localName(name) {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function namespaceFor(name, namespaces) {
  const separator = name.indexOf(":");
  return separator < 0 ? namespaces.get("") : namespaces.get(name.slice(0, separator));
}

function decodeXmlText(value) {
  let invalid = false;
  const unresolved = value.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/gu, "");
  const text = value.replace(/&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/gu, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return "\"";
    if (entity === "&apos;") return "'";
    const numeric = entity.slice(2, -1);
    const codePoint = numeric.startsWith("x") || numeric.startsWith("X")
      ? Number.parseInt(numeric.slice(1), 16)
      : Number.parseInt(numeric, 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      invalid = true;
      return "";
    }
    return String.fromCodePoint(codePoint);
  });
  if (/&/u.test(unresolved)) invalid = true;
  return invalid ? undefined : text;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function isAvif(bytes) {
  if (bytes.byteLength < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 4, 4) !== "ftyp") return false;
  let size = view.getUint32(0);
  let header = 8;
  if (size === 1) {
    if (bytes.byteLength < 24 || view.getUint32(8) !== 0) return false;
    size = view.getUint32(12);
    header = 16;
  } else if (size === 0) size = bytes.byteLength;
  if (size < header + 8 || size > bytes.byteLength || (size - header - 8) % 4 !== 0) return false;
  for (let offset = header; offset < size; offset += 4) {
    if (offset === header + 4) continue; // The minor-version field is not a brand.
    const brand = ascii(bytes, offset, 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

function hasSvgRoot(bytes) {
  // Icon inspection only recognizes a bounded XML prolog and root signature;
  // it never parses, fetches, or expands any SVG declaration.
  let text;
  try {
    // Streaming ignores a partial trailing UTF-8 sequence when the byte prefix
    // ends inside SVG content; malformed sequences inside the prefix still fail.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 8_192), { stream: bytes.byteLength > 8_192 });
  } catch { return false; }
  const boundedProlog = text.replace(
    /^\uFEFF?\s*(?:(?:<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg(?:\s+[^<>]*)?>)\s*)*/iu,
    "",
  );
  return /^<svg(?:\s|\/?>)/iu.test(boundedProlog);
}

function isUsableLocalImage(file) {
  const content = file?.content;
  if (!(content instanceof Uint8Array) || content.byteLength === 0) return false;
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  if (file.mediaType === "image/png") {
    return bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (file.mediaType === "image/jpeg") return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mediaType === "image/gif") return bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a";
  if (file.mediaType === "image/webp") return bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (file.mediaType === "image/x-icon" || file.mediaType === "image/vnd.microsoft.icon") return bytes.byteLength >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  if (file.mediaType === "image/svg+xml") {
    return hasSvgRoot(bytes);
  }
  return file.mediaType === "image/avif" && isAvif(bytes);
}

function sitemapLocations(xml, errors) {

  const locations = [];
  const stack = [];
  let rootSeen = false;
  let offset = 0;
  let tokens = 0;
  while (offset < xml.length) {
    const next = xml.indexOf("<", offset);
    if (next < 0) {
      const text = xml.slice(offset);
      if (stack.at(-1)?.local === "loc") stack.at(-1).text += text;
      else if (stack.length === 0 && text.trim() !== "") {
        boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains text outside its XML document."));
      }
      break;
    }
    const text = xml.slice(offset, next);
    if (stack.at(-1)?.local === "loc") stack.at(-1).text += text;
    else if (stack.length === 0 && text.trim() !== "") {
      boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains text outside an XML element."));
      return [];
    }
    if (xml.startsWith("<!--", next)) {
      const end = xml.indexOf("-->", next + 4);
      if (end < 0) {
        boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains an unterminated XML comment."));
        return [];
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith("<?", next)) {
      const end = xml.indexOf("?>", next + 2);
      if (end < 0) {
        boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains an unterminated XML declaration."));
        return [];
      }
      offset = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", next)) {
      const end = xml.indexOf("]]>", next + 9);
      if (end < 0 || stack.length === 0) {
        boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains invalid CDATA."));
        return [];
      }
      if (stack.at(-1)?.local === "loc") stack.at(-1).text += xml.slice(next + 9, end).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
      offset = end + 3;
      continue;
    }
    if (/^<!(?:DOCTYPE|ENTITY)/iu.test(xml.slice(next, next + 10))) {
      boundedPush(errors, diagnostic("sitemap.unsafe_xml", "sitemap.xml", "Sitemaps may not declare DTDs or entities."));
      return [];
    }
    const tag = readXmlTag(xml, next);
    if (!tag || ++tokens > MAX_XML_TOKENS) {
      boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap exceeds the bounded XML parser envelope."));
      return [];
    }
    const parsed = parseXmlTag(tag.text);
    if (!parsed) {
      boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains a malformed XML element."));
      return [];
    }
    if (parsed.kind === "close") {
      const current = stack.pop();
      if (!current || current.name !== parsed.name) {
        boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap has mismatched XML elements."));
        return [];
      }
      const parent = stack.at(-1);
      if (current.local === "loc" && current.namespace === SITEMAP_NAMESPACE && parent?.local === "url" && parent.namespace === SITEMAP_NAMESPACE) {
        const decoded = decodeXmlText(current.text)?.trim();
        if (!decoded) {
          boundedPush(errors, diagnostic("sitemap.url_invalid", "sitemap.xml", "A sitemap location is empty or contains an invalid XML entity."));
        } else if (locations.length < MAX_SITEMAP_URLS) {
          locations.push(decoded);
        } else {
          boundedPush(errors, diagnostic("sitemap.too_many_urls", "sitemap.xml", "The sitemap exceeds the bounded URL inventory."));
          return [];
        }
      }
      offset = tag.end;
      continue;
    }
    if (stack.length >= MAX_XML_DEPTH) {
      boundedPush(errors, diagnostic("sitemap.too_deep", "sitemap.xml", "The sitemap exceeds the XML nesting limit."));
      return [];
    }
    const namespaces = new Map(stack.at(-1)?.namespaces ?? []);
    for (const [name, value] of parsed.attributes) {
      if (name === "xmlns") namespaces.set("", decodeXmlText(value) ?? value);
      else if (name.startsWith("xmlns:")) namespaces.set(name.slice("xmlns:".length), decodeXmlText(value) ?? value);
      if (namespaces.size > MAX_XML_NAMESPACES) {
        boundedPush(errors, diagnostic("sitemap.too_many_namespaces", "sitemap.xml", "The sitemap exceeds the XML namespace limit."));
        return [];
      }
    }
    const current = {
      name: parsed.name,
      local: localName(parsed.name),
      namespace: namespaceFor(parsed.name, namespaces),
      namespaces,
      text: "",
    };
    if (!rootSeen) {
      rootSeen = true;
      if (current.local !== "urlset" || current.namespace !== SITEMAP_NAMESPACE) {
        boundedPush(errors, diagnostic("sitemap.namespace", "sitemap.xml", "The sitemap root must be an URL set in the standard sitemap namespace."));
        return [];
      }
    } else if (stack.length === 0) {
      boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap contains more than one root element."));
      return [];
    }
    if (parsed.selfClosing) {
      const parent = stack.at(-1);
      if (current.local === "loc" && current.namespace === SITEMAP_NAMESPACE && parent?.local === "url" && parent.namespace === SITEMAP_NAMESPACE) {
        boundedPush(errors, diagnostic("sitemap.url_invalid", "sitemap.xml", "A sitemap location may not be empty."));
      }
    } else {
      stack.push(current);
    }
    offset = tag.end;
  }
  if (!rootSeen || stack.length !== 0) {
    boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap XML document is incomplete."));
    return [];
  }
  return locations;
}

function inspectSitemap(text, expectedOrigin, inventory, errors, warnings) {
  const locations = sitemapLocations(text, errors);
  // The bounded inspection above rejects oversized/nested/DTD inputs first.
  // Check full text syntax, including ignored extension text and attributes.
  if (errors.length === 0) {
    try {
      new SaxesParser({ xmlns: true }).write(text).close();
    } catch {
      boundedPush(errors, diagnostic("sitemap.invalid_xml", "sitemap.xml", "The sitemap is not well-formed XML."));
      return;
    }
  }
  if (locations.length === 0 && errors.length === 0) {
    boundedPush(warnings, diagnostic("sitemap.empty", "sitemap.xml", "The sitemap has no page URLs."));
  }
  if (!expectedOrigin && locations.length > 0) {
    boundedPush(warnings, diagnostic("sitemap.origin_unconfigured", "sitemap.xml", "No production origin is configured for sitemap authority checks."));
  }
  const seen = new Set();
  for (const location of locations) {
    let url;
    try {
      url = new URL(location);
    } catch {
      boundedPush(errors, diagnostic("sitemap.url_invalid", "sitemap.xml", "A sitemap location is not an absolute HTTPS URL."));
      continue;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
      boundedPush(errors, diagnostic("sitemap.url_invalid", "sitemap.xml", "A sitemap location is not a canonical HTTPS URL."));
      continue;
    }
    if (expectedOrigin && url.origin !== expectedOrigin) {
      boundedPush(errors, diagnostic("sitemap.origin", "sitemap.xml", "A sitemap URL does not use the configured production origin."));
      continue;
    }
    if (url.search !== "" || url.hash !== "" || location.includes("%") || location !== url.href) {
      boundedPush(errors, diagnostic(location.includes("%") ? "sitemap.encoded_route" : "sitemap.url_not_canonical", "sitemap.xml", "A sitemap location must be an unencoded canonical artifact URL."));
      continue;
    }
    const identity = `${url.origin}${url.pathname}`;
    if (seen.has(identity)) {
      boundedPush(errors, diagnostic("sitemap.duplicate_url", "sitemap.xml", "The sitemap repeats a page URL."));
      continue;
    }
    seen.add(identity);
    if (inventory.redirects.has(url.pathname)) {
      boundedPush(errors, diagnostic("sitemap.redirect_route", "sitemap.xml", "A sitemap URL resolves through a declared redirect rather than a page."));
      continue;
    }
    const file = inventory.files.get(url.pathname);
    if (!file) {
      boundedPush(errors, diagnostic("sitemap.route_missing", "sitemap.xml", "A sitemap URL does not map to a declared prebuilt route."));
      continue;
    }
    if (file.mediaType !== "text/html; charset=utf-8") {
      boundedPush(errors, diagnostic("sitemap.route_not_html", "sitemap.xml", "A sitemap URL must map to a declared HTML page."));
    }
  }
}

function parseHtmlTags(html, errors) {
  const tags = [];
  // ASCII folding preserves source offsets for non-ASCII text.
  const lowerHtml = html.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  let offset = 0;
  let tokens = 0;
  let templateDepth = 0;
  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (start < 0) break;
    if (++tokens > MAX_HTML_TOKENS) {
      boundedPush(errors, diagnostic("homepage.too_many_tokens", "index.html", "The homepage exceeds the bounded HTML token limit."));
      return [];
    }
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      offset = end < 0 ? html.length : end + 3;
      continue;
    }
    const end = readXmlTag(html, start);
    if (!end) break;
    const raw = end.text;
    if (/^<\/template(?:\s|>)/iu.test(end.text)) templateDepth = Math.max(0, templateDepth - 1);
    const match = /^<\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)>$/u.exec(raw);
    if (!match || raw.startsWith("</")) {
      offset = end.end;
      continue;
    }
    const tagName = match[1].toLowerCase();
    const body = (match[2] ?? "").replace(/\/\s*$/u, "");
    const attributes = new Map();
    let cursor = 0;
    while (cursor < body.length) {
      while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
      if (cursor >= body.length) break;
      const attribute = /^([A-Za-z_:][A-Za-z0-9:_.-]*)/u.exec(body.slice(cursor));
      if (!attribute) break;
      const name = attribute[1].toLowerCase();
      cursor += attribute[1].length;
      while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
      let value = "";
      if (body[cursor] === "=") {
        cursor += 1;
        while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
        const quote = body[cursor];
        if (quote === "\"" || quote === "'") {
          cursor += 1;
          const valueEnd = body.indexOf(quote, cursor);
          if (valueEnd < 0) break;
          value = body.slice(cursor, valueEnd);
          cursor = valueEnd + 1;
        } else {
          const valueEnd = body.slice(cursor).search(/[\s>]/u);
          value = valueEnd < 0 ? body.slice(cursor) : body.slice(cursor, cursor + valueEnd);
          cursor += value.length;
        }
      }
      if (!attributes.has(name)) attributes.set(name, decodeXmlText(value) ?? value);
    }
    if (tagName === "template") templateDepth += 1;
    if (templateDepth === 0) tags.push({ name: tagName, attributes });
    offset = end.end;
    if (tagName === "plaintext") break;
    if (["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"].includes(tagName)) {
      let close = lowerHtml.indexOf(`</${tagName}`, offset);
      while (close >= 0 && !/[\s/>]/u.test(lowerHtml[close + tagName.length + 2] ?? "")) {
        close = lowerHtml.indexOf(`</${tagName}`, close + 2);
      }
      offset = close < 0 ? html.length : close;
    }
  }
  return tags;
}

function tokenList(value) {
  return (value ?? "").toLowerCase().split(/[\s,]+/u).filter(Boolean);
}

function homepageBaseUrl(tags, expectedOrigin, errors) {
  const fallback = `${expectedOrigin ?? "https://artifact.invalid"}/`;
  const base = tags.find((tag) => tag.name === "base");
  if (!base) return fallback;
  const href = base.attributes.get("href");
  if (!href) {
    boundedPush(errors, diagnostic("homepage.base_missing_href", "index.html", "The homepage base declaration has no URL."));
    return fallback;
  }
  try {
    const url = new URL(href, fallback);
    if (url.origin !== new URL(fallback).origin || url.username !== "" || url.password !== "") {
      boundedPush(errors, diagnostic("homepage.base_external", "index.html", "The homepage base URL must remain on the artifact origin."));
      return fallback;
    }
    return url.href;
  } catch {
    boundedPush(errors, diagnostic("homepage.base_invalid", "index.html", "The homepage base declaration is not a valid URL."));
    return fallback;
  }
}

function inspectRobots(text, errors) {
  let agents = [];
  let rules = [];
  let hasRule = false;
  const groups = [];
  const flush = () => {
    if (agents.length > 0) groups.push({ agents, rules });
    agents = [];
    rules = [];
    hasRule = false;
  };
  for (const sourceLine of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = sourceLine.split("#", 1)[0].trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "user-agent") {
      if (hasRule) flush();
      if (value) agents.push(value.toLowerCase());
    } else if ((name === "disallow" || name === "allow") && agents.length > 0) {
      hasRule = true;
      rules.push({ name, value });
    }
  }
  flush();
  for (const group of groups.filter((candidate) => candidate.agents.includes("*"))) {
    const rootBlocked = group.rules.some((rule) => rule.name === "disallow" && rule.value === "/");
    const rootAllowed = group.rules.some((rule) => rule.name === "allow" && rule.value === "/");
    if (rootBlocked && !rootAllowed) {
      boundedPush(errors, diagnostic("robots.crawl_blocked", "robots.txt", "robots.txt blocks generic crawlers from the production homepage."));
    }
  }
}

function inspectHomepage(html, expectedOrigin, inventory, errors, warnings) {
  const tags = parseHtmlTags(html, errors);
  const baseUrl = homepageBaseUrl(tags, expectedOrigin, errors);
  let canonicalCount = 0;
  let localIconCount = 0;
  let externalIconCount = 0;
  for (const tag of tags) {
    if (tag.name === "meta") {
      const name = tag.attributes.get("name")?.toLowerCase();
      const httpEquiv = tag.attributes.get("http-equiv")?.toLowerCase();
      if ((name === "robots" || name === "googlebot" || httpEquiv === "x-robots-tag") && tokenList(tag.attributes.get("content")).some((token) => token === "noindex" || token === "none")) {
        boundedPush(errors, diagnostic("homepage.noindex", "index.html", "The homepage declares noindex for production crawlers."));
      }
      continue;
    }
    if (tag.name !== "link") continue;
    const rel = tokenList(tag.attributes.get("rel"));
    const href = tag.attributes.get("href");
    if (rel.includes("canonical")) {
      canonicalCount += 1;
      if (!href) {
        boundedPush(errors, diagnostic("homepage.canonical_missing_href", "index.html", "The homepage canonical declaration has no URL."));
        continue;
      }
      let url;
      try {
        url = expectedOrigin ? new URL(href) : new URL(href, baseUrl);
      } catch {
        boundedPush(errors, diagnostic("homepage.canonical_invalid", "index.html", "The homepage canonical declaration is not a valid URL."));
        continue;
      }
      if (expectedOrigin && (url.origin !== expectedOrigin || url.username || url.password)) {
        boundedPush(errors, diagnostic("homepage.canonical_origin", "index.html", "The homepage canonical URL does not use the production origin."));
      } else {
        if (!expectedOrigin) {
          boundedPush(warnings, diagnostic("homepage.origin_unconfigured", "index.html", "No production origin is configured for canonical-link checks."));
        }
        if (url.href !== `${expectedOrigin ?? url.origin}/` || url.pathname !== "/" || url.search !== "" || url.hash !== "" || href.includes("%")) {
          boundedPush(errors, diagnostic("homepage.canonical_not_root", "index.html", "The homepage canonical URL must be the unencoded production root."));
        }
      }
    }
    const icon = rel.includes("icon") || rel.includes("apple-touch-icon") || rel.includes("mask-icon");
    if (!icon) continue;
    if (!href) {
      boundedPush(errors, diagnostic("homepage.icon_missing_href", "index.html", "A homepage icon declaration has no URL."));
      continue;
    }
    if (/^data:/iu.test(href)) {
      externalIconCount += 1;
      continue;
    }
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      boundedPush(errors, diagnostic("homepage.icon_invalid", "index.html", "A homepage icon declaration is not a valid URL."));
      continue;
    }
    const local = (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href) && !href.startsWith("//"))
      || (expectedOrigin && url.origin === expectedOrigin);
    if (!local) {
      externalIconCount += 1;
      continue;
    }
    if (url.pathname.includes("%")) {
      boundedPush(errors, diagnostic("homepage.icon_encoded_route", "index.html", "A local icon declaration may not percent-encode an artifact route."));
      continue;
    }
    const file = inventory.files.get(url.pathname);
    if (!file || !file.mediaType.startsWith("image/") || !isUsableLocalImage(file)) {
      boundedPush(errors, diagnostic("homepage.icon_local_missing", "index.html", "A local homepage icon does not map to a declared image asset."));
      continue;
    }
    localIconCount += 1;
  }
  if (canonicalCount === 0) {
    boundedPush(warnings, diagnostic("homepage.canonical_missing", "index.html", "The homepage has no canonical URL declaration."));
  }
  const favicon = inventory.files.get("/favicon.ico");
  if (localIconCount === 0 && !isUsableLocalImage(favicon)) {
    boundedPush(warnings, diagnostic("homepage.icon_missing", "index.html", "The homepage has no declared local icon or /favicon.ico fallback."));
  }
  if (externalIconCount > 0) {
    boundedPush(warnings, diagnostic("homepage.icon_external", "index.html", "External or data icon URLs were not fetched or verified."));
  }
}

/**
 * Inspects the frozen prebuilt snapshot that the publisher will archive. It is
 * intentionally read-only: no declared URL is fetched and no payload is run.
 */
export function inspectPrebuiltDiscovery(snapshot, { productionOrigin } = {}) {
  const errors = [];
  const warnings = [];
  const expectedOrigin = validateProductionOrigin(productionOrigin);
  if (productionOrigin !== undefined && !expectedOrigin) {
    boundedPush(errors, diagnostic("production_origin.invalid", "$config.productionOrigin", "productionOrigin must be a canonical HTTPS origin."));
  }
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const inventory = routeInventory(snapshot.manifest, files);
  const sitemap = files.get("sitemap.xml");
  if (!sitemap) {
    boundedPush(warnings, diagnostic("sitemap.missing", "sitemap.xml", "The prebuilt artifact does not include a sitemap recommendation."));
  } else {
    const text = inspectTextFile(sitemap, "sitemap.xml", errors);
    if (text !== undefined) inspectSitemap(text, expectedOrigin, inventory, errors, warnings);
  }
  const robots = files.get("robots.txt");
  if (!robots) {
    boundedPush(warnings, diagnostic("robots.missing", "robots.txt", "The prebuilt artifact does not include a robots.txt recommendation."));
  } else {
    const text = inspectTextFile(robots, "robots.txt", errors);
    if (text !== undefined) inspectRobots(text, errors);
  }
  const homepage = files.get("index.html");
  if (!homepage) {
    boundedPush(warnings, diagnostic("homepage.missing", "index.html", "The prebuilt artifact has no root homepage to inspect."));
  } else {
    const text = inspectTextFile(homepage, "index.html", errors);
    if (text !== undefined) inspectHomepage(text, expectedOrigin, inventory, errors, warnings);
  }
  return Object.freeze({ errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
}
