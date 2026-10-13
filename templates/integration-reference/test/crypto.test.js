import assert from "node:assert/strict";
import test from "node:test";

import { decrypt, encrypt } from "../src/crypto.js";

test("encrypted installation values are bound to their installation and column purpose", () => {
  const key = Buffer.alloc(32, 7);
  const envelope = encrypt("credential-value", key, "installation:abc:credential");
  assert.equal(decrypt(envelope, key, "installation:abc:credential").toString("utf8"), "credential-value");
  assert.throws(() => decrypt(envelope, key, "installation:def:credential"));
});
