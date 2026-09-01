import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { atomicWriteFile } from "./atomic-file.js";
import { readBoundedFile } from "./bounded-file.js";
import { SITE_AUTHORING_CAPABILITIES } from "./capabilities.js";

import {
  CANONICAL_TIMESTAMP,
  CLI_BINARY_NAME,
  CREDENTIAL_DIRECTORY_MODE,
  CREDENTIAL_DIRECTORY_NAME,
  CREDENTIAL_FILE_MODE,
  CREDENTIAL_FILE_NAME,
  CREDENTIAL_STORE_VERSION,
  LIMITS,
  VERB_LOGOUT,
} from "./constants.js";
import { hasAsciiControl, isCanonicalUuid, SiteAuthoringError } from "./errors.js";
import { isWellFormedCredential, MAXIMUM_TOKEN_LENGTH } from "./transport.js";

/**
 * The credential `login` writes, `openSession` reads, and `logout` removes.
 *
 * Four properties are the whole point of this module:
 *
 * 1. **It is outside the repository.** The store lives under the user's
 *    configuration directory. A credential inside a working tree is one
 *    `git add -A` from being published and one shared checkout from being
 *    someone else's.
 * 2. **Its location comes from the injected environment**, not from
 *    `process.env`. Tests point HOME and XDG_CONFIG_HOME at a temporary
 *    directory and get complete control; `os.homedir()` is consulted only when
 *    the environment carries neither.
 * 3. **The write is atomic and narrow.** Directory `0700`, file `0600`,
 *    temp-file + `O_EXCL|O_NOFOLLOW` + fsync + rename — `atomicWriteFile`,
 *    the same primitive `writeWorkspaceFile` uses. What stays here is the part
 *    that is actually about a credential: the `0700` directory this file lives
 *    in, deliberately outside every workspace, and the mode pinned past the
 *    operator's umask.
 * 4. **A read refuses what it cannot vouch for.** A symlink, a non-regular
 *    file, an oversized file, or a malformed record is a stable refusal, not a
 *    silently ignored entry — a store that quietly drops the record you just
 *    wrote is indistinguishable from one that never wrote it.
 *
 * The key itself never leaves this module except as the value `openSession`
 * hands straight to `SiteApiClient`. Nothing here puts it in an error message,
 * a progress line, or a result.
 */

// The display prefix the API mints (`tr_live_` + eight characters + "..."). A
// display value, never a secret, but still bounded and printable. Exported so
// the wire layer accepts exactly what this store will keep: a prefix accepted
// on claim but refused on save would turn a successful mint into an orphaned
// key.
export const KEY_PREFIX = /^[\w.-]{1,64}$/u;

// Stand-ins for the fields a pre-mint projection cannot know yet. Each is the
// largest value its own validator accepts, so the projected record is an upper
// bound on the real one rather than a guess at it.
const PROJECTION_UUID = "00000000-0000-4000-8000-000000000000";
const PROJECTION_TIMESTAMP = "2000-01-01T00:00:00.000Z";
const PROJECTION_KEY_PREFIX_LENGTH = 64;

function usableDirectory(value) {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= LIMITS.configPathBytes
    && !hasAsciiControl(value)
    && path.isAbsolute(value);
}

/**
 * `$XDG_CONFIG_HOME`, else `$HOME/.config`, else the runtime's own home. The
 * environment is read from the invocation, never from `process.env`, so a test
 * can relocate the store without mutating the process it runs in.
 */
export function credentialStoreDirectory(environment = {}) {
  const configHome = environment?.XDG_CONFIG_HOME;
  if (usableDirectory(configHome)) return path.join(configHome, CREDENTIAL_DIRECTORY_NAME);
  const home = environment?.HOME;
  const base = usableDirectory(home) ? home : os.homedir();
  if (!usableDirectory(base)) {
    throw new SiteAuthoringError(
      "credentials.home_unknown",
      "No home or XDG_CONFIG_HOME directory could be resolved for the stored credential.",
    );
  }
  return path.join(base, ".config", CREDENTIAL_DIRECTORY_NAME);
}

export function credentialStorePath(environment = {}) {
  return path.join(credentialStoreDirectory(environment), CREDENTIAL_FILE_NAME);
}

/** The store key: one sign-in per API origin, replaced on re-login. */
export function credentialApiOrigin(apiBaseUrl) {
  return new URL(apiBaseUrl).origin;
}

function requireStoreShape(condition, message) {
  if (!condition) throw new SiteAuthoringError("credentials.contract", message);
}

/**
 * Validates one stored record. `key` clears exactly the bar the transport
 * applies to `TAPROOT_SITE_KEY`, because it reaches exactly the same header.
 */
function normalizeEntry(entry) {
  requireStoreShape(
    entry !== null && typeof entry === "object" && !Array.isArray(entry),
    "A stored credential record is not an object.",
  );
  requireStoreShape(
    typeof entry.apiOrigin === "string" && entry.apiOrigin.length > 0 && entry.apiOrigin.length <= 2_048,
    "A stored credential record has an invalid apiOrigin.",
  );
  requireStoreShape(isCanonicalUuid(entry.accountId), "A stored credential record has an invalid accountId.");
  requireStoreShape(isWellFormedCredential(entry.key), "A stored credential record has an invalid key.");
  requireStoreShape(isCanonicalUuid(entry.keyId), "A stored credential record has an invalid keyId.");
  requireStoreShape(
    typeof entry.keyPrefix === "string" && KEY_PREFIX.test(entry.keyPrefix),
    "A stored credential record has an invalid keyPrefix.",
  );
  requireStoreShape(
    entry.keyExpiresAt === undefined
      || (typeof entry.keyExpiresAt === "string" && CANONICAL_TIMESTAMP.test(entry.keyExpiresAt)),
    "A stored credential record has an invalid keyExpiresAt.",
  );
  requireStoreShape(
    typeof entry.createdAt === "string" && CANONICAL_TIMESTAMP.test(entry.createdAt),
    "A stored credential record has an invalid createdAt.",
  );
  // What the last exchange produced. Entirely non-secret — a site id, the
  // capabilities that exchange asked for, and when the credential it returned
  // dies — and the only way `whoami` can answer "what can this actually do"
  // without a network round trip. Absent before the first exchange.
  requireStoreShape(
    entry.lastExchange === undefined
      || (entry.lastExchange !== null
        && typeof entry.lastExchange === "object"
        && !Array.isArray(entry.lastExchange)
        && isCanonicalUuid(entry.lastExchange.siteId)
        && Array.isArray(entry.lastExchange.capabilities)
        && entry.lastExchange.capabilities.every((value) => typeof value === "string")
        && typeof entry.lastExchange.expiresAt === "string"
        && CANONICAL_TIMESTAMP.test(entry.lastExchange.expiresAt)),
    "A stored credential record has an invalid lastExchange.",
  );
  return Object.freeze({
    apiOrigin: entry.apiOrigin,
    accountId: entry.accountId,
    key: entry.key,
    keyId: entry.keyId,
    keyPrefix: entry.keyPrefix,
    ...(entry.keyExpiresAt === undefined ? {} : { keyExpiresAt: entry.keyExpiresAt }),
    ...(entry.lastExchange === undefined ? {} : {
      lastExchange: Object.freeze({
        siteId: entry.lastExchange.siteId,
        capabilities: Object.freeze([...entry.lastExchange.capabilities]),
        expiresAt: entry.lastExchange.expiresAt,
      }),
    }),
    createdAt: entry.createdAt,
  });
}

async function readStoreBytes(filePath) {
  return await readBoundedFile(filePath, {
    maximumBytes: LIMITS.credentialsBytes,
    failures: {
      isOwn: (error) => error instanceof SiteAuthoringError,
      // A missing store is the ordinary state before the first login, not a
      // failure: `openSession` needs to be able to say "no credential anywhere".
      // `readBoundedFile` answers that with undefined before any of these.
      inspect: () =>
        new SiteAuthoringError("credentials.unreadable", "Could not inspect the stored credential file."),
      notRegular: () =>
        new SiteAuthoringError(
          "credentials.not_regular",
          "The stored credential file must be a regular file, not a link or directory.",
        ),
      tooLarge: () =>
        new SiteAuthoringError(
          "credentials.too_large",
          `The stored credential file exceeds ${LIMITS.credentialsBytes} bytes.`,
        ),
      changed: () =>
        new SiteAuthoringError("credentials.changed", "The stored credential file changed while it was being opened."),
      read: () => new SiteAuthoringError("credentials.unreadable", "Could not read the stored credential file."),
    },
  });
}

/**
 * Names the store file in a refusal. Both login and logout route through the
 * same store, so an unusable file fails them identically — and the one thing
 * the operator needs in order to repair or remove it is which of the candidate
 * locations it actually is. The path is operator-local and not a secret.
 */
function namedStoreFailure(error, filePath) {
  if (!(error instanceof SiteAuthoringError) || error.message.includes(filePath)) return error;
  return new SiteAuthoringError(
    error.code,
    `${error.message.replace(/\.$/u, "")} (${filePath}).`,
    {
      ...(error.field === undefined ? {} : { field: error.field }),
      ...(error.status === undefined ? {} : { status: error.status }),
      exitCode: error.exitCode,
    },
  );
}

/**
 * Reads the whole store. A missing file yields an empty store; anything else
 * that cannot be vouched for is a stable refusal naming the file it is about.
 */
export async function readCredentialStore(environment = {}) {
  const filePath = credentialStorePath(environment);
  try {
    const bytes = await readStoreBytes(filePath);
    if (bytes === undefined || bytes.byteLength === 0) return { path: filePath, credentials: [] };
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SiteAuthoringError("credentials.invalid_json", "The stored credential file is not valid JSON.");
    }
    requireStoreShape(
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
      "The stored credential file is not a JSON object.",
    );
    if (parsed.schemaVersion !== CREDENTIAL_STORE_VERSION) {
      throw new SiteAuthoringError(
        "credentials.unsupported_version",
        `The stored credential file must declare schemaVersion ${CREDENTIAL_STORE_VERSION}.`,
      );
    }
    requireStoreShape(Array.isArray(parsed.credentials), "The stored credential file has no credentials array.");
    return { path: filePath, credentials: parsed.credentials.map(normalizeEntry) };
  } catch (error) {
    throw namedStoreFailure(error, filePath);
  }
}

/**
 * The one sign-in for this API origin, or undefined.
 *
 * Keyed by origin alone since TR00645. Through TR00602 this was keyed by
 * `(origin, siteId)` because every stored credential authorized exactly one
 * site; the sign-in credential authorizes an account, and an operator has one
 * of those per Taproot they use.
 */
export function selectCredential(credentials, apiOrigin) {
  return credentials.find((entry) => entry.apiOrigin === apiOrigin);
}

export async function findCredential(environment, apiOrigin) {
  const store = await readCredentialStore(environment);
  return { path: store.path, credential: selectCredential(store.credentials, apiOrigin) };
}

/**
 * Narrows a mode that is wider than it should be, and never widens one. On
 * Windows `chmod` is advisory at best, so a failure here is not a failure of
 * the write it accompanies.
 */
async function narrowMode(target, allowed) {
  try {
    const current = await stat(target);
    const mode = current.mode & 0o777;
    if ((mode & ~allowed) !== 0) await chmod(target, mode & allowed);
  } catch {
    // Best-effort only; the store's real protection is the directory it is in.
  }
}

async function ensureStoreDirectory(directory) {
  try {
    await mkdir(directory, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  } catch {
    throw new SiteAuthoringError(
      "credentials.unwritable",
      "Could not create the configuration directory for the stored credential.",
    );
  }
  let stats;
  try {
    stats = await lstat(directory);
  } catch {
    throw new SiteAuthoringError(
      "credentials.unwritable",
      "Could not inspect the configuration directory for the stored credential.",
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SiteAuthoringError(
      "credentials.directory_invalid",
      "The credential directory must be a real directory, not a link or file.",
    );
  }
  await narrowMode(directory, CREDENTIAL_DIRECTORY_MODE);
}

/**
 * Replaces the whole store atomically. The temp file is created `0600` with
 * `O_EXCL|O_NOFOLLOW`, fsynced, then renamed over the destination — so a
 * concurrent reader sees either the old complete store or the new one, and
 * never a half-written file with a truncated key in it.
 */
async function writeCredentialStore(filePath, credentials) {
  try {
    return await writeCredentialStoreUnnamed(filePath, credentials);
  } catch (error) {
    throw namedStoreFailure(error, filePath);
  }
}

/**
 * The exact bytes a given set of records becomes on disk. Shared by the write
 * and by the pre-mint projection so the two cannot disagree about the format
 * they are each measuring.
 */
function serializeStore(credentials) {
  return `${JSON.stringify({ schemaVersion: CREDENTIAL_STORE_VERSION, credentials }, undefined, 2)}\n`;
}

/**
 * Refuses a store this module's own reader would then refuse.
 *
 * `readStoreBytes` caps the file at `credentialsBytes`, and TR00645 removed the
 * record-count bound that used to keep it under that cap — so without this the
 * writer and the reader no longer agree on what is acceptable, and the failure
 * takes the worst shape available: the write succeeds, and every subsequent
 * read fails permanently against a store the operator did not knowingly create.
 * Checked in bytes, not records, because bytes are what the reader checks.
 */
function requireStoreFits(contents) {
  if (Buffer.byteLength(contents, "utf8") > LIMITS.credentialsBytes) {
    throw new SiteAuthoringError(
      "credentials.too_large",
      `The stored credential file would exceed ${LIMITS.credentialsBytes} bytes. `
        + `Run '${CLI_BINARY_NAME} ${VERB_LOGOUT}' against a Taproot you no longer author.`,
    );
  }
}

async function writeCredentialStoreUnnamed(filePath, credentials) {
  await ensureStoreDirectory(path.dirname(filePath));
  const contents = serializeStore(credentials);
  requireStoreFits(contents);

  // `pinMode` matters here and not in the workspace: the creation mode is
  // umask-narrowed, and this file must be exactly 0600 whatever the operator's
  // umask says, not merely no wider than it.
  return await atomicWriteFile(filePath, contents, {
    mode: CREDENTIAL_FILE_MODE,
    pinMode: true,
    failures: {
      inspect: () =>
        new SiteAuthoringError("credentials.unwritable", "Could not inspect the stored credential file."),
      notRegular: () =>
        new SiteAuthoringError(
          "credentials.not_regular",
          "The stored credential file must be a regular file, not a link or directory.",
        ),
      write: () =>
        new SiteAuthoringError("credentials.unwritable", "Could not write the stored credential file."),
    },
  });
}

function defaultLockSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Serializes the store's read-modify-write.
 *
 * TR00645 removed this on the reasoning that one record per origin left no
 * array to merge. That reasoning was wrong, and the lock is back: the store
 * holds one record *per origin*, not one record. An operator who uses both
 * production and a local Tilt has two, and two overlapping writes still each
 * read the same array, each write their own complete copy, and the second
 * rename still silently discards the first's record — a live, unrevoked
 * credential whose local copy just vanished.
 *
 * The rename inside `writeCredentialStore` is atomic; the read-filter-write
 * sequence around it is not, and that is what this guards. The lock is an
 * `O_EXCL` file beside the store; contention is human-scale and brief, and a
 * leftover lock from a crashed process fails loudly with its path rather than
 * hanging.
 */
async function withStoreLock(filePath, action, { sleep = defaultLockSleep } = {}) {
  const directory = path.dirname(filePath);
  await ensureStoreDirectory(directory);
  const lockPath = `${filePath}.lock`;
  let handle;
  for (let attempt = 1;; attempt++) {
    try {
      handle = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        CREDENTIAL_FILE_MODE,
      );
      break;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        if (attempt >= LIMITS.credentialLockAttempts) {
          throw namedStoreFailure(
            new SiteAuthoringError(
              "credentials.locked",
              "Another taproot-site command is updating the stored credential file. "
                + "If none is running, remove the leftover lock file.",
            ),
            lockPath,
          );
        }
        await sleep(LIMITS.credentialLockRetryMilliseconds);
        continue;
      }
      throw namedStoreFailure(
        new SiteAuthoringError(
          "credentials.unwritable",
          "Could not create the lock file beside the stored credential file.",
        ),
        lockPath,
      );
    }
  }
  try {
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Refuses, before anything is minted, a login whose credential could not then
 * be stored.
 *
 * The write-time bound alone is not enough for `login`. By the time the write
 * runs the credential exists on the server, so a refusal there is the one
 * outcome the login path works hardest to avoid: a live credential nobody
 * holds, which the operator has to go and revoke by hand. Projecting the
 * post-save size before the claim converts that into an ordinary refusal
 * costing nothing.
 *
 * The projection is deliberately pessimistic. It measures a record with a
 * maximum-length key, a maximum-length display prefix, and the `lastExchange`
 * block a first exchange will add — none of which are known yet at preflight,
 * and all of which only grow the record. Over-refusing here means telling
 * someone with a nearly full store to log out of a Taproot they no longer use;
 * under-refusing means orphaning a credential. The asymmetry picks the side.
 */
export async function assertCredentialCapacity(environment, apiOrigin) {
  const store = await readCredentialStore(environment);
  const projected = normalizeEntry({
    apiOrigin,
    accountId: PROJECTION_UUID,
    key: "k".repeat(MAXIMUM_TOKEN_LENGTH),
    keyId: PROJECTION_UUID,
    keyPrefix: "p".repeat(PROJECTION_KEY_PREFIX_LENGTH),
    keyExpiresAt: PROJECTION_TIMESTAMP,
    lastExchange: {
      siteId: PROJECTION_UUID,
      capabilities: [...SITE_AUTHORING_CAPABILITIES],
      expiresAt: PROJECTION_TIMESTAMP,
    },
    createdAt: PROJECTION_TIMESTAMP,
  });
  const others = store.credentials.filter((entry) => entry.apiOrigin !== apiOrigin);
  requireStoreFits(serializeStore([...others, projected]));
  return store.path;
}

/**
 * Stores the one sign-in for this API origin, replacing any prior record.
 * `createdAt` comes from the injected clock, so a test observes a deterministic
 * record. The whole read-modify-write runs under the store lock.
 */
export async function saveCredential(environment, credential, { now = Date.now, sleep } = {}) {
  const record = normalizeEntry({
    ...credential,
    createdAt: new Date(now()).toISOString(),
  });
  const filePath = credentialStorePath(environment);
  return withStoreLock(filePath, async () => {
    const store = await readCredentialStore(environment);
    const others = store.credentials.filter((entry) => entry.apiOrigin !== record.apiOrigin);
    const ordered = [...others, record].sort((left, right) => left.apiOrigin.localeCompare(right.apiOrigin));
    await writeCredentialStore(store.path, ordered);
    return store.path;
  }, { sleep });
}

/**
 * Updates the non-secret metadata on a stored sign-in, and only if it is still
 * the same credential.
 *
 * A plain `saveCredential` would not do: the caller read the record before a
 * network round trip, and in that window a concurrent `logout` may have removed
 * it or a concurrent `login` may have replaced it. Writing the pre-flight copy
 * back would resurrect a discarded credential or overwrite a newer one with a
 * stale key. So the read, the identity check, and the write all happen inside
 * the same lock, and a credential that is no longer the one we exchanged with
 * is left exactly as it is.
 *
 * Metadata only: this never touches the key. Returns whether it updated.
 */
export async function updateCredentialMetadata(environment, apiOrigin, keyId, metadata, { sleep } = {}) {
  const filePath = credentialStorePath(environment);
  return withStoreLock(filePath, async () => {
    const store = await readCredentialStore(environment);
    const current = selectCredential(store.credentials, apiOrigin);
    if (current === undefined || current.keyId !== keyId) return false;

    const updated = normalizeEntry({ ...current, ...metadata });
    const others = store.credentials.filter((entry) => entry.apiOrigin !== apiOrigin);
    const ordered = [...others, updated].sort((left, right) => left.apiOrigin.localeCompare(right.apiOrigin));
    await writeCredentialStore(store.path, ordered);
    return true;
  }, { sleep });
}

/**
 * Local discard. Returns whether anything was there — a logout with nothing
 * stored is a successful no-op, not an error, because the state the caller
 * asked for is the state they end up in. The read-modify-write runs under the
 * same store lock the save takes.
 */
export async function removeCredential(environment, apiOrigin, { sleep } = {}) {
  const filePath = credentialStorePath(environment);
  return withStoreLock(filePath, async () => {
    const store = await readCredentialStore(environment);
    const remaining = store.credentials.filter((entry) => entry.apiOrigin !== apiOrigin);
    if (remaining.length === store.credentials.length) return { path: store.path, removed: false };
    await writeCredentialStore(store.path, remaining);
    return { path: store.path, removed: true };
  }, { sleep });
}
