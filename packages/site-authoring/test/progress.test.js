import assert from "node:assert/strict";
import test from "node:test";

import { poll } from "../src/api.js";
import { createProgressReporter, formatElapsed, PROGRESS_HEARTBEAT_MILLISECONDS } from "../src/progress.js";

function fixture({ isTTY, quiet = false, columns, interactive } = {}) {
  const written = [];
  let clock = 1_000_000;
  const timers = [];
  const stream = { isTTY, columns, write: (text) => written.push(text) };
  const reporter = createProgressReporter({
    stream,
    ...(interactive === undefined ? {} : { interactive }),
    quiet,
    now: () => clock,
    setInterval: (callback) => {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      timer.cleared = true;
    },
  });
  return {
    reporter,
    written,
    timers,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    text: () => written.join(""),
  };
}

const WAIT = (phase) => [`Waiting for the deployment (${phase}).`, { phase }];

test("formatElapsed reads as seconds, then minutes and seconds", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(125_000), "2m 5s");
});

test("off a terminal, a wait writes a line per phase change and no control characters", () => {
  const { reporter, written, advance, text } = fixture({ isTTY: false });

  reporter.report(...WAIT("RENDERING"));
  advance(2_000);
  reporter.report(...WAIT("RENDERING"));
  advance(2_000);
  reporter.report(...WAIT("UPLOADING"));
  reporter.stop();

  assert.deepEqual(written, [
    "Waiting for the deployment (RENDERING).\n",
    "Waiting for the deployment (UPLOADING).\n",
  ]);
  assert.doesNotMatch(text(), /[\u0000-\u0009\u000B-\u001F\u007F]/u);
});

test("off a terminal, a long silent phase gets a heartbeat at most once a minute", () => {
  const { reporter, written, advance } = fixture({ isTTY: false });

  reporter.report(...WAIT("UPLOADING"));
  for (let tick = 0; tick < 20; tick += 1) {
    advance(2_000);
    reporter.report(...WAIT("UPLOADING"));
  }
  assert.equal(written.length, 1, "no heartbeat inside the first minute");

  advance(PROGRESS_HEARTBEAT_MILLISECONDS);
  reporter.report(...WAIT("UPLOADING"));
  advance(2_000);
  reporter.report(...WAIT("UPLOADING"));

  assert.equal(written.length, 2);
  assert.match(written[1], /^Still waiting for the deployment \(UPLOADING\); 1m 40s elapsed\.\n$/u);
});

test("a plain line resets the heartbeat clock", () => {
  const { reporter, written, advance } = fixture({ isTTY: false });
  reporter.report(...WAIT("UPLOADING"));
  advance(50_000);
  reporter.report("Deployment phase UPLOADING entered now.");
  advance(30_000);
  reporter.report(...WAIT("UPLOADING"));

  assert.equal(written.length, 2);
});

test("on a terminal, a wait is one in-place line that redraws and a new line starts only on a phase change", () => {
  const { reporter, written, timers, advance, text } = fixture({ isTTY: true });

  reporter.report(...WAIT("RENDERING"));
  advance(3_000);
  reporter.report(...WAIT("RENDERING"));
  timers[0].callback();
  assert.equal(timers.length, 1, "one redraw timer for the whole wait");
  assert.ok(written.every((chunk) => !chunk.endsWith("\n")), "no newline while the phase is unchanged");
  assert.match(written.at(-1), /^\r\u001B\[2K. Waiting for the deployment \(RENDERING\); 3s in this phase, 3s total$/u);

  advance(4_000);
  reporter.report(...WAIT("UPLOADING"));

  assert.match(text(), /Deployment phase RENDERING finished after 7s\.\n/u);
  assert.match(written.at(-1), /Waiting for the deployment \(UPLOADING\); 0s in this phase, 7s total$/u);
});

test("on a terminal, another line wipes the wait line first and the wait line returns after it", () => {
  const { reporter, written } = fixture({ isTTY: true });
  reporter.report(...WAIT("RENDERING"));
  written.length = 0;

  reporter.report("Warning: something worth reading.");

  assert.equal(written[0], "\r\u001B[2K");
  assert.equal(written[1], "Warning: something worth reading.\n");
  assert.match(written[2], /Waiting for the deployment \(RENDERING\)/u);
});

test("stop wipes the in-place line, cancels the redraw, and is safe to repeat", () => {
  const { reporter, written, timers } = fixture({ isTTY: true });
  reporter.report(...WAIT("RENDERING"));

  reporter.stop();
  reporter.stop();

  assert.equal(timers[0].cleared, true);
  assert.equal(written.at(-1), "\r\u001B[2K");
});

test("quiet writes nothing in either mode", () => {
  for (const isTTY of [true, false]) {
    const { reporter, written } = fixture({ isTTY, quiet: true });
    reporter.report("A line.");
    reporter.report(...WAIT("RENDERING"));
    reporter.stop();
    assert.deepEqual(written, []);
  }
});

test("a poll hands its progress event to the reporter", async () => {
  const seen = [];
  let reads = 0;
  await poll({
    client: { sleep: async () => {}, signal: undefined },
    now: () => 0,
    timeoutMilliseconds: 10_000,
    intervalMilliseconds: 1,
    onProgress: (message, event) => seen.push([message, event]),
    read: async () => (reads += 1),
    evaluate: (value) => value < 2
      ? { done: false, progress: "Waiting.", event: { phase: "RENDERING" } }
      : { done: true, value },
    timeoutCode: "test.timeout",
  });

  assert.deepEqual(seen, [["Waiting.", { phase: "RENDERING" }]]);
});

test("endWait wipes the in-place line and cancels the redraw while the run carries on", () => {
  const { reporter, written, timers } = fixture({ isTTY: true });
  reporter.report(...WAIT("DEPLOYING"));

  reporter.endWait();
  reporter.report("Checking staging redirects.");

  assert.equal(timers[0].cleared, true);
  assert.equal(written.at(-1), "Checking staging redirects.\n");
  assert.ok(!written.at(-1).includes("Waiting for the deployment"));
});

test("the in-place line fits one row and keeps the phase and both counters at real widths", () => {
  for (const columns of [80, 60, 40]) {
    const { reporter, written, advance } = fixture({ isTTY: true, columns });
    reporter.report(...WAIT("DEPLOYMENT_STATUS_QUEUED"));
    advance(30_000);
    reporter.report(...WAIT("DEPLOYMENT_STATUS_GENERATING"));
    advance(35_000);
    reporter.report(...WAIT("DEPLOYMENT_STATUS_GENERATING"));

    const line = written.at(-1).replace("\r\u001B[2K", "");
    assert.ok(line.length <= columns - 1, `${columns} columns: ${line}`);
    assert.match(line, /GENERATING/u);
    assert.match(line, /35s/u, "the time in this phase shows");
    assert.match(line, /1m 5s/u, "the total shows");
  }
});

test("a terminal that cannot redraw is handled as a log", () => {
  const { reporter, written } = fixture({ isTTY: true, interactive: false });

  reporter.report(...WAIT("RENDERING"));
  reporter.report(...WAIT("RENDERING"));

  assert.deepEqual(written, ["Waiting for the deployment (RENDERING).\n"]);
});
