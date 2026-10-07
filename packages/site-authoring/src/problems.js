import { SiteAuthoringError } from "./errors.js";

/**
 * Collecting problems instead of stopping at the first (TR01002, TR00823).
 *
 * A check that runs over a whole workspace reports every refusal it finds, so
 * an importer fixing hundreds of converted pages learns them all in one run.
 * Only `SiteAuthoringError`s are collected: anything else is a defect, and
 * hiding it inside a list would turn a crash into a refusal.
 */

/** The parts of a workspace a check reports a problem against. */
export const CHECK_AREA = Object.freeze({
  media: "media",
  pages: "pages",
  presentation: "presentation",
  footer: "footer",
  navigation: "navigation",
  redirects: "redirects",
  forms: "forms",
});

// Kept off the JSON so a problem serializes as plain data, but remembered so a
// single refusal can be rethrown exactly as it was raised.
const SOURCE = Symbol("source error");

function withContext(problem, context, error) {
  const located = {
    ...(context.area === undefined ? {} : { area: context.area }),
    ...(context.file === undefined || problem.file !== undefined ? {} : { file: context.file }),
    ...problem,
  };
  if (located.field === located.file) delete located.field;
  Object.defineProperty(located, SOURCE, { value: error });
  return located;
}

/** The problems one refusal stands for: its own list when it carries one, otherwise itself. */
export function problemsOf(error, context = {}) {
  const own = Array.isArray(error.problems) && error.problems.length > 0
    ? error.problems
    : [{ code: error.code, ...(error.field === undefined ? {} : { field: error.field }), message: error.message }];
  return own.map((problem) => withContext(problem, context, error));
}

/**
 * Runs `action`, adding its refusal to `problems` instead of throwing. Returns
 * the action's value, or undefined when it refused.
 */
export async function collectProblems(problems, context, action) {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof SiteAuthoringError)) throw error;
    problems.push(...problemsOf(error, context));
    return undefined;
  }
}

/**
 * One refusal for a list of problems. When they all came from one refusal it
 * is rethrown as raised, alternatives and differences included, so a check
 * that finds one problem fails exactly as it did before problems were
 * collected. Otherwise the code, message and field are the first refusal's and
 * `error.problems` lists every problem.
 */
export function problemsError(problems, summary) {
  const [first] = problems;
  if (problems.every((problem) => problem[SOURCE] !== undefined && problem[SOURCE] === first[SOURCE])) {
    return first[SOURCE];
  }
  return new SiteAuthoringError(
    first[SOURCE]?.code ?? first.code,
    `${summary}: ${problems.length} problems. First: ${first[SOURCE]?.message ?? first.message}`,
    { field: first[SOURCE]?.field ?? first.field ?? first.file },
  ).withProblems(problems);
}

// A whole-workspace check can find thousands of problems. A JSON result keeps
// as many as fit well inside its 64 KiB bound; stderr lists them all.
const PROBLEM_BUDGET_BYTES = 40 * 1024;

/** The leading items whose JSON fits `budget` bytes. */
export function withinByteBudget(items, budget) {
  const kept = [];
  let bytes = 0;
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
    if (bytes > budget) break;
    kept.push(item);
  }
  return kept;
}

/** The leading problems that fit the result's byte budget, or a smaller one. */
export function problemsWithinBudget(problems, budget = PROBLEM_BUDGET_BYTES) {
  return withinByteBudget(problems, Math.min(budget, PROBLEM_BUDGET_BYTES));
}

/**
 * Under `apply`, a step refuses to send what its plan did not list: an input
 * edited, or a site state changed, while an earlier step ran was never reviewed.
 */
export function planStale(subject, field) {
  return new SiteAuthoringError(
    "apply.plan_stale",
    `${subject} changed after the plan was made, so this step stopped before sending it. Run 'taproot-site plan' again and `
      + "apply the new planHash.",
    { field },
  );
}

/** Throws when `problems` is not empty. */
export function refuseProblems(problems, summary) {
  if (problems.length > 0) throw problemsError(problems, summary);
}
