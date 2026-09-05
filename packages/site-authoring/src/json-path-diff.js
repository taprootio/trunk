/**
 * Says *what* differs between two page documents, in JSON paths.
 *
 * A conflict that only says "this page changed on the site" leaves the operator
 * with a choice nobody can make well: re-push identical content, or abandon the
 * local source. On the SHY production home page (2026-09-03) the entire
 * difference was `$.content[0].attrs.decoration.image.src` and the sibling
 * `.urls` — two fields the API re-projects on every read from live image state
 * — and a list of paths would have shown that in one line.
 *
 * This decides nothing. The revision comparison decides; this explains it. So
 * it is deliberately generous about what counts as a difference and strictly
 * bounded in what it will spend finding out: a diagnostic that hangs on a
 * hostile document is worse than one that says "and more".
 */

/** How many differing paths one report carries before it says "and more". */
export const JSON_DIFFERENCE_LIMIT = 20;

/**
 * How deep the comparison descends. `canonicalDocumentHash` refuses a document
 * nesting deeper than this, and every document compared here has already been
 * through it, so the bound is unreachable for real content. A subtree at the
 * bound is reported as differing rather than skipped in silence: over-reporting
 * a diagnostic is safe, and quietly not comparing is not.
 */
const MAXIMUM_DEPTH = 100;

/**
 * A ceiling on total work, because both sides are documents this process did
 * not author: one is the site's, the other a file on disk.
 */
const MAXIMUM_VISITS = 200_000;

/** How much of one object key a path segment carries. */
const MAXIMUM_SEGMENT_SCALARS = 64;

/** How long one rendered path may be before its middle is elided. */
const MAXIMUM_PATH_SCALARS = 200;

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function boundSegment(key) {
  const scalars = [...key];
  return scalars.length <= MAXIMUM_SEGMENT_SCALARS
    ? key
    : `${scalars.slice(0, MAXIMUM_SEGMENT_SCALARS).join("")}…`;
}

function childPath(path, key) {
  const segment = boundSegment(key);
  return PLAIN_KEY.test(segment) ? `${path}.${segment}` : `${path}[${JSON.stringify(segment)}]`;
}

function indexPath(path, index) {
  return `${path}[${index}]`;
}

function boundPath(path) {
  const scalars = [...path];
  if (scalars.length <= MAXIMUM_PATH_SCALARS) return path;
  const head = scalars.slice(0, MAXIMUM_PATH_SCALARS - 20).join("");
  const tail = scalars.slice(-19).join("");
  return `${head}…${tail}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The paths at which two parsed JSON values differ.
 *
 * Returns `{ paths, truncated }`. `paths` is empty when the two documents are
 * structurally identical — which, on a page whose revision moved, is the useful
 * answer: the stored state changed in a field this comparison does not cover.
 *
 * `truncated` means the walk stopped early — either more than `limit`
 * differences exist, or the documents are large enough to have exhausted the
 * work ceiling — so the list is a sample rather than the whole story.
 */
export function describeJsonDifferences(left, right, { limit = JSON_DIFFERENCE_LIMIT } = {}) {
  const bound = Number.isSafeInteger(limit) && limit > 0 ? limit : JSON_DIFFERENCE_LIMIT;
  // One past the reported bound. Stopping *at* the bound could not tell "these
  // are all of them" from "there were more", and a sample presented as a
  // complete list is the kind of diagnostic that sends someone looking in the
  // wrong place.
  const cap = bound + 1;
  const paths = [];
  let exhausted = false;
  let visits = 0;

  const record = (path) => {
    paths.push(boundPath(path));
  };

  const walk = (leftValue, rightValue, path, depth) => {
    if (paths.length >= cap || exhausted) return;
    visits += 1;
    if (visits > MAXIMUM_VISITS) {
      exhausted = true;
      return;
    }
    if (depth > MAXIMUM_DEPTH) {
      record(path);
      return;
    }

    if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
      const shared = Math.min(leftValue.length, rightValue.length);
      for (let index = 0; index < shared; index += 1) {
        walk(leftValue[index], rightValue[index], indexPath(path, index), depth + 1);
        if (paths.length >= cap || exhausted) return;
      }
      // An added or removed element is named by its own index rather than by
      // the array, so "one section was appended" reads differently from "every
      // section moved".
      for (let index = shared; index < Math.max(leftValue.length, rightValue.length); index += 1) {
        record(indexPath(path, index));
        if (paths.length >= cap || exhausted) return;
      }
      return;
    }

    if (isPlainObject(leftValue) && isPlainObject(rightValue)) {
      // Sorted so two runs over the same pair of documents report the same
      // paths in the same order, whatever order the members arrived in.
      const keys = [...new Set([...Object.keys(leftValue), ...Object.keys(rightValue)])].sort();
      for (const key of keys) {
        const inLeft = Object.hasOwn(leftValue, key);
        const inRight = Object.hasOwn(rightValue, key);
        if (!inLeft || !inRight) {
          record(childPath(path, key));
        } else {
          walk(leftValue[key], rightValue[key], childPath(path, key), depth + 1);
        }
        if (paths.length >= cap || exhausted) return;
      }
      return;
    }

    // Different kinds, or two scalars. `Object.is` rather than `===` so two
    // NaN bodies do not read as a difference; JSON has no NaN, but these
    // documents reach here through `JSON.parse` of untrusted bytes and a
    // caller may hand over something else.
    if (!Object.is(leftValue, rightValue)) record(path);
  };

  walk(left, right, "$", 0);
  return { paths: paths.slice(0, bound), truncated: exhausted || paths.length > bound };
}

/**
 * The paths a conflict may claim, or `undefined` when no claim is honest.
 *
 * An empty list is the statement "compared, and the body is identical", which
 * an agent reads as "look at the title, path, or description instead". That
 * statement cannot be made when nothing was compared, and it cannot be made
 * when the walk exhausted its budget before it reached a difference: two
 * documents that agree for the first two hundred thousand nodes and differ
 * afterwards are different, not identical.
 */
export function reportableDifferencePaths(differences) {
  if (differences === undefined) return undefined;
  if (differences.paths.length === 0 && differences.truncated) return undefined;
  return differences.paths;
}
