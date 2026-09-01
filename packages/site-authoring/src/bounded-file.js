import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/**
 * One bounded, no-follow read of a small local file, shared by the credential
 * store and the machine settings (TR00645).
 *
 * The discipline: `lstat` first and refuse anything that is not a regular file
 * (so a symlink is never followed), open with `O_NOFOLLOW | O_NONBLOCK` (so a
 * FIFO or device swapped in under the path cannot block the process), confirm
 * the opened inode is the one inspected, and read at most `maximumBytes + 1`
 * — the extra byte is how "too large" is detected without trusting the size
 * `lstat` reported. A plain `readFile` does none of that: it follows links,
 * blocks on a FIFO, and reads an unbounded device to exhaustion before any
 * post-read size check can run.
 *
 * Parameterized the way `atomicWriteFile` is: the caller supplies the failure
 * factories so each store keeps its own error vocabulary, and one reader keeps
 * one set of checks. A missing file resolves to `undefined`, because for both
 * callers absence is a state — no sign-in yet, production by default — rather
 * than a failure.
 */
export async function readBoundedFile(filePath, { maximumBytes, failures }) {
  let stats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw failures.inspect();
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw failures.notRegular();
  if (stats.size > BigInt(maximumBytes)) throw failures.tooLarge();

  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) throw failures.changed();
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    while (total <= maximumBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maximumBytes) throw failures.tooLarge();
    return buffer.subarray(0, total);
  } catch (error) {
    // The factories above produce the caller's own error type; anything else
    // is the filesystem talking, and gets the caller's generic read failure.
    if (error instanceof Error && failures.isOwn(error)) throw error;
    throw failures.read();
  } finally {
    await handle?.close().catch(() => {});
  }
}
