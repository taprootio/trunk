import { TIME_TOLERANCE_MS } from "./timing-config.js";

export { TIME_TOLERANCE_MS };

const nanosecondsPerUnit = Object.freeze({
  seconds: 1_000_000_000,
  milliseconds: 1_000_000,
  microseconds: 1_000,
  nanoseconds: 1,
});

function check(actual, expected, unit) {
  if (!Object.hasOwn(nanosecondsPerUnit, unit)) throw new TypeError(`Unknown time unit: ${unit}`);
  if (typeof actual !== typeof expected || !["number", "bigint"].includes(typeof actual)) {
    throw new TypeError("Time values must both be numbers or both be bigints.");
  }
  if (typeof actual === "number" && (!Number.isFinite(actual) || !Number.isFinite(expected))) {
    throw new TypeError("Time values must be finite.");
  }
}

export function isTimeWithinTolerance(actual, expected, unit = "milliseconds") {
  check(actual, expected, unit);
  const difference = actual >= expected ? actual - expected : expected - actual;
  if (typeof difference === "bigint") {
    return difference * BigInt(nanosecondsPerUnit[unit]) <= BigInt(TIME_TOLERANCE_MS) * 1_000_000n;
  }
  return difference <= TIME_TOLERANCE_MS * 1_000_000 / nanosecondsPerUnit[unit];
}

function requireTime(condition, actual, expected, unit, relationship) {
  if (!condition) {
    throw new Error(`Expected ${String(actual)} ${unit} ${relationship} ${String(expected)}; tolerance is ±${TIME_TOLERANCE_MS} milliseconds.`);
  }
}

export function assertTimeCloseTo(actual, expected, unit = "milliseconds") {
  requireTime(isTimeWithinTolerance(actual, expected, unit), actual, expected, unit, "within tolerance of");
}

export function assertTimeAtLeast(actual, minimum, unit = "milliseconds") {
  check(actual, minimum, unit);
  requireTime(actual >= minimum || isTimeWithinTolerance(actual, minimum, unit), actual, minimum, unit, "at least");
}

export function assertTimeAtMost(actual, maximum, unit = "milliseconds") {
  check(actual, maximum, unit);
  requireTime(actual <= maximum || isTimeWithinTolerance(actual, maximum, unit), actual, maximum, unit, "at most");
}

export function assertTimeBetween(actual, minimum, maximum, unit = "milliseconds") {
  check(minimum, maximum, unit);
  if (minimum > maximum) throw new RangeError("The minimum time must not exceed the maximum.");
  assertTimeAtLeast(actual, minimum, unit);
  assertTimeAtMost(actual, maximum, unit);
}

export function assertTimeNotCloseTo(actual, expected, unit = "milliseconds") {
  requireTime(!isTimeWithinTolerance(actual, expected, unit), actual, expected, unit, "more than the tolerance away from");
}

export function assertTimeAfter(actual, expected, unit = "milliseconds") {
  check(actual, expected, unit);
  requireTime(actual > expected && !isTimeWithinTolerance(actual, expected, unit), actual, expected, unit, "more than the tolerance after");
}

export function assertTimeBefore(actual, expected, unit = "milliseconds") {
  check(actual, expected, unit);
  requireTime(actual < expected && !isTimeWithinTolerance(actual, expected, unit), actual, expected, unit, "more than the tolerance before");
}
