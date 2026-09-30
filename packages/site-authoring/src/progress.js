/**
 * Human progress for a long wait, written to stderr (stdout stays the one JSON
 * result). Verbs report plain lines through `report(message)`; a wait reports
 * `report(message, { phase })` once per poll, and this decides how much of that
 * a reader should see.
 *
 * - On a terminal, a wait is one in-place line (spinner, phase, elapsed time)
 *   that redraws each second, and a new line starts only when the phase changes.
 *   Any other line clears the in-place line first, then the wait line comes back.
 * - Off a terminal (a pipe, CI), no control characters are ever written: one line
 *   per phase change, plus a heartbeat at most every `heartbeatMilliseconds` so a
 *   long silent phase does not look hung.
 */
const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const ERASE_LINE = "\r\u001B[2K";

export const PROGRESS_HEARTBEAT_MILLISECONDS = 60_000;
const REDRAW_MILLISECONDS = 1_000;

export function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * @param {{
 *   stream: { write(text: string): unknown, isTTY?: boolean, columns?: number },
 *   interactive?: boolean,
 *   quiet?: boolean,
 *   now?: () => number,
 *   heartbeatMilliseconds?: number,
 *   setInterval?: typeof setInterval,
 *   clearInterval?: typeof clearInterval,
 * }} options
 */
export function createProgressReporter({
  stream,
  // A terminal that cannot redraw (TERM=dumb) is handled as a log, like a pipe.
  interactive = stream.isTTY === true,
  quiet = false,
  now = Date.now,
  heartbeatMilliseconds = PROGRESS_HEARTBEAT_MILLISECONDS,
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
}) {
  let phase;
  let phaseStartedAt = 0;
  let waitStartedAt = 0;
  let lastLineAt = 0;
  let frame = 0;
  let inPlace = false;
  let timer;

  function draw() {
    if (phase === undefined) return;
    frame = (frame + 1) % SPINNER_FRAMES.length;
    const short = phase.replace(/^DEPLOYMENT_STATUS_/u, "");
    const inPhase = formatElapsed(now() - phaseStartedAt);
    const total = formatElapsed(now() - waitStartedAt);
    // One row only: a wrapped line would leave rows the next redraw cannot clear.
    // The phase and both counters are what a reader needs, so the wording around
    // them is what gives way on a narrow terminal.
    const width = Math.max(10, (stream.columns ?? 80) - 1);
    const candidates = [
      `${SPINNER_FRAMES[frame]} Waiting for the deployment (${short}); ${inPhase} in this phase, ${total} total`,
      `${SPINNER_FRAMES[frame]} ${short}: ${inPhase} in phase, ${total} total`,
      `${SPINNER_FRAMES[frame]} ${short} ${inPhase} (${total} total)`,
    ];
    const text = candidates.find((candidate) => candidate.length <= width) ?? candidates.at(-1).slice(0, width);
    stream.write(`${ERASE_LINE}${text}`);
    inPlace = true;
  }

  function clearInPlace() {
    if (!inPlace) return;
    stream.write(ERASE_LINE);
    inPlace = false;
  }

  function endWait() {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    clearInPlace();
    phase = undefined;
  }

  function line(text) {
    stream.write(`${text}\n`);
    lastLineAt = now();
  }

  return {
    report(message, event) {
      if (quiet) return;
      if (event?.phase === undefined) {
        // A plain line. On a terminal the wait line is wiped and redrawn by the
        // next tick, so the message is never glued to a half-written spinner.
        clearInPlace();
        line(message);
        if (interactive && phase !== undefined) draw();
        return;
      }
      const at = now();
      if (phase === undefined) waitStartedAt = at;
      const changed = phase !== event.phase;
      if (changed) {
        // The finished phase stays on screen as a line of its own.
        if (interactive && phase !== undefined) {
          clearInPlace();
          line(`Deployment phase ${phase} finished after ${formatElapsed(at - phaseStartedAt)}.`);
        }
        phase = event.phase;
        phaseStartedAt = at;
      }
      if (interactive) {
        draw();
        if (timer === undefined) {
          timer = schedule(draw, REDRAW_MILLISECONDS);
          timer.unref?.();
        }
        return;
      }
      if (changed) {
        line(message);
      } else if (at - lastLineAt >= heartbeatMilliseconds) {
        line(`Still waiting for the deployment (${phase}); ${formatElapsed(at - waitStartedAt)} elapsed.`);
      }
    },

    /** Ends the wait for a deployment (it finished or failed) while the run carries on. */
    endWait,

    /** Ends any wait in progress. Safe to call more than once. */
    stop() {
      endWait();
    },
  };
}
