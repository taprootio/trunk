import { sanitizeDiagnostic } from "../errors.js";
import { boundedByBytes } from "../session.js";
import { contentDocuments } from "../typed-pages.js";
import { displayPagePath } from "../workspace.js";

/**
 * Links the editor made on its own before TR01191: text such as "ASP.NET"
 * whose address is just "http://ASP.NET". The address names the text and
 * nothing else (no path, query or fragment), so the author almost certainly
 * never chose it. Reported as warnings so an author can remove them.
 */
export const LINK_AUTOLINKED = "content.link_autolinked";

// Progress names this many; the JSON list is bounded by bytes instead.
const MAXIMUM_PROGRESS_LINES = 20;

export function autolinkedLinks(document) {
  const found = [];
  (function walk(node, depth) {
    if (depth > 64 || node === null || typeof node !== "object" || !Array.isArray(node.content)) return;
    // A link split across runs (part of it bold, say) is one link, so adjacent
    // text sharing one href is read as one label.
    let run;
    const close = () => {
      if (run !== undefined && looksAutolinked(run.text, run.href)) found.push(run);
      run = undefined;
    };
    for (const child of node.content) {
      const href = child?.type === "text" && typeof child.text === "string" && Array.isArray(child.marks)
        ? child.marks.find((mark) => mark?.type === "link")?.attrs?.href
        : undefined;
      if (typeof href !== "string") {
        close();
        walk(child, depth + 1);
      } else if (run !== undefined && run.href === href) {
        run.text += child.text;
      } else {
        close();
        run = { text: child.text, href };
      }
    }
    close();
  })(document, 0);
  return found;
}

function looksAutolinked(text, href) {
  const label = text.trim();
  if (label === "" || /^[a-z][a-z0-9+.-]*:/iu.test(label)) return false;
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.port !== "") {
    return false;
  }
  const written = href.replace(/^https?:\/\//iu, "").replace(/\/$/u, "");
  return written.toLowerCase() === label.toLowerCase();
}

/**
 * Links that look made by the editor's old autolinking ("ASP.NET" linked to
 * http://ASP.NET), named so an author can remove them; never a refusal.
 */
export function autolinkWarnings(planned, onProgress) {
  const items = [];
  for (const page of planned ?? []) {
    for (const link of pageDocuments(page.document).flatMap((document) => autolinkedLinks(document))) {
      const item = {
        code: LINK_AUTOLINKED,
        file: page.file,
        path: displayPagePath(page.pagePath),
        text: [...sanitizeDiagnostic(link.text, "")].slice(0, 200).join(""),
        href: [...sanitizeDiagnostic(link.href, "")].slice(0, 300).join(""),
      };
      if (items.length < MAXIMUM_PROGRESS_LINES) {
        onProgress(
          `Warning: '${item.text}' in ${item.file} links to ${item.href}, which looks made by autolinking; `
            + "remove the link if nobody chose it.",
        );
      }
      items.push(item);
    }
  }
  if (items.length > MAXIMUM_PROGRESS_LINES) {
    onProgress(`Warning: ${items.length - MAXIMUM_PROGRESS_LINES} more autolink-shaped link(s); see linkWarnings.`);
  }
  const reported = boundedByBytes(items, 8 * 1024);
  return items.length === 0
    ? {}
    : { linkWarnings: { total: items.length, items: reported.items, ...(reported.truncated ? { truncated: true } : {}) } };
}

/**
 * Every ProseMirror document a page carries: a free-form body, or a typed
 * page's body, introduction and recipe steps. A page that failed validation
 * may have none.
 */
function pageDocuments(document) {
  if (document === null || typeof document !== "object") return [];
  try {
    return contentDocuments(document).map((entry) => entry.doc);
  } catch {
    return [];
  }
}
