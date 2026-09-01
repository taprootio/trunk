import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { SiteAuthoringError } from "./errors.js";

/**
 * The one durable single-file write in this package (TR00645).
 *
 * Two callers need the identical sequence and used to carry their own copy of
 * it: `writeWorkspaceFile` in `workspace.js`, which replaces a pulled page, and
 * the credential store in `credentials.js`, which replaces the file holding a
 * live key. The credential module's comment acknowledged the duplication and
 * justified it on the grounds that the workspace function is bound to a
 * validated workspace — true of that function's *path handling*, and not of the
 * write discipline underneath it. Splitting the two apart leaves one primitive
 * here and each caller's own containment rules where they belong.
 *
 * The discipline, and why each step is in it:
 *
 * 1. **`lstat` the destination first.** A symlink or a non-regular file at the
 *    target is refused rather than followed, so neither caller can be turned
 *    into a writer of some other file by something planted in its directory.
 *    `lstat` rather than `stat` is the whole point — `stat` would resolve the
 *    link and report the target as a perfectly ordinary file.
 * 2. **Write a temp file in the same directory**, opened
 *    `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`. `O_EXCL` means an attacker cannot
 *    pre-create the temp path and have us write through it; `O_NOFOLLOW` means
 *    they cannot pre-create it as a link. Same directory so the rename below is
 *    a rename and not a cross-device copy.
 * 3. **fsync before the rename.** The rename is the commit point, and a rename
 *    that commits a file whose contents have not reached disk is exactly how a
 *    crash produces a truncated credential or a half-written page.
 * 4. **Rename over the destination.** Atomic, so a concurrent reader sees the
 *    complete old file or the complete new one and never a partial write.
 * 5. **Best-effort parent-directory sync**, which makes the rename itself
 *    durable. Deliberately swallowed: the replacement is already live, and
 *    platforms that refuse directory handles must not turn a committed write
 *    into a reported failure.
 * 6. **Unlink the temp file on any failure**, so a failed write leaves nothing
 *    behind to accumulate beside the real one.
 *
 * Messages stay with the callers. Both surfaces have their own vocabulary and
 * their own error codes, and collapsing them into one generic "could not write
 * file" would make every refusal less useful than the two it replaced — so the
 * caller supplies the three failures this can produce.
 */

/**
 * Replaces one file atomically.
 *
 * @param {string} filePath Absolute path to replace. Callers are responsible
 *   for having validated it and for having created its directory.
 * @param {string} contents UTF-8 contents to write.
 * @param {object} options
 * @param {number} [options.mode] Creation mode for the temp file. Defaults to
 *   `0600`, the safe choice for both current callers.
 * @param {boolean} [options.pinMode] Re-apply `mode` with an explicit `chmod`
 *   after writing. The creation mode is narrowed by the process umask, so a
 *   file that must be exactly `0600` whatever the operator's umask says needs
 *   this; a file that only must not be *wider* than `mode` does not. Advisory
 *   on Windows, so a failure here never fails the write.
 * @param {Function} [options.openDirectory] Injection seam for the parent
 *   directory sync, so a test can exercise the unsupported-directory-handle
 *   path without a platform that has one.
 * @param {{inspect: Function, notRegular: Function, write: Function}}
 *   options.failures Factories for this caller's three refusals.
 * @returns {Promise<string>} The path that was replaced.
 */
export async function atomicWriteFile(filePath, contents, {
  mode = 0o600,
  pinMode = false,
  openDirectory = open,
  failures,
} = {}) {
  const directory = path.dirname(filePath);

  let existing;
  try {
    existing = await lstat(filePath);
  } catch (error) {
    // A missing destination is the ordinary case for a first write, not a
    // failure. Anything else means we cannot vouch for what is there.
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw failures.inspect();
    }
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw failures.notRegular();
  }

  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      mode,
    );
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (pinMode) {
      try {
        await chmod(temporaryPath, mode);
      } catch {
        // Best-effort: Windows does not honor POSIX modes.
      }
    }
    await rename(temporaryPath, filePath);
    renamed = true;
  } catch (error) {
    if (error instanceof SiteAuthoringError) throw error;
    throw failures.write();
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }

  let directoryHandle;
  try {
    directoryHandle = await openDirectory(
      directory,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
    );
    await directoryHandle.sync();
  } catch {
    // Best-effort durability only; the complete replacement is already live.
  } finally {
    await directoryHandle?.close().catch(() => {});
  }
  return filePath;
}
