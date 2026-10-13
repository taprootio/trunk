import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { claimWebhookReceipt, finishWebhookReceipt, parseWebhookEvent, verifyWebhookSignature } from "../src/index.js";

const root = new URL("../fixtures/webhooks/v1/", import.meta.url);

test("signature vector verifies the exact published installation.created bytes", async () => {
  const vector = JSON.parse(await readFile(new URL("signature-vector.json", root), "utf8"));
  const body = new Uint8Array(await readFile(new URL(vector.bodyFile, root)));
  const event = JSON.parse(new TextDecoder().decode(body));
  const verified = verifyWebhookSignature({
    headers: {
      "Taproot-Signature": vector.header,
      "Taproot-Delivery-Id": event.id,
      "Taproot-Event": event.type,
      "Taproot-Installation-Id": event.installationId,
    },
    body,
    signingSecrets: { [vector.keyId]: vector.signingSecretBase64 },
    now: new Date(vector.timestamp * 1000),
  });

  assert.equal(verified.bodySha256, vector.bodySha256);
  assert.equal(verified.event.type, "installation.created");
  assert.equal(verified.event.data.claimCode, "fixture-claim-code");
});

test("verification rejects a reformatted or changed signed body", async () => {
  const vector = JSON.parse(await readFile(new URL("signature-vector.json", root), "utf8"));
  const body = await readFile(new URL(vector.bodyFile, root), "utf8");
  const event = JSON.parse(body);
  assert.throws(() => verifyWebhookSignature({
    headers: {
      "Taproot-Signature": vector.header,
      "Taproot-Delivery-Id": event.id,
      "Taproot-Event": event.type,
      "Taproot-Installation-Id": event.installationId,
    },
    body: `${body}\n`,
    signingSecrets: { [vector.keyId]: vector.signingSecretBase64 },
    now: vector.timestamp * 1000,
  }), { code: "invalid_signature" });
});

test("verification reports an unconfigured signature key without treating it as malformed key material", async () => {
  const vector = JSON.parse(await readFile(new URL("signature-vector.json", root), "utf8"));
  const body = new Uint8Array(await readFile(new URL(vector.bodyFile, root)));
  const event = JSON.parse(new TextDecoder().decode(body));
  assert.throws(() => verifyWebhookSignature({
    headers: {
      "Taproot-Signature": vector.header,
      "Taproot-Delivery-Id": event.id,
      "Taproot-Event": event.type,
      "Taproot-Installation-Id": event.installationId,
    },
    body,
    signingSecrets: {},
    now: vector.timestamp * 1000,
  }), { code: "unknown_signing_key" });
});

test("page.deleted uses its published revision field rather than page.publishedRevision", async () => {
  const pageDeleted = JSON.parse(await readFile(new URL("examples/page.deleted.json", root), "utf8"));
  const pagePublished = JSON.parse(await readFile(new URL("examples/page.published.json", root), "utf8"));
  assert.equal(parseWebhookEvent(JSON.stringify(pageDeleted)).data.revision, 15);
  assert.equal(parseWebhookEvent(JSON.stringify(pagePublished)).data.publishedRevision, 14);
});

test("receipt claims receive immutable signed metadata before processing", async () => {
  const vector = JSON.parse(await readFile(new URL("signature-vector.json", root), "utf8"));
  const body = new Uint8Array(await readFile(new URL(vector.bodyFile, root)));
  const event = JSON.parse(new TextDecoder().decode(body));
  const verified = verifyWebhookSignature({
    headers: { "Taproot-Signature": vector.header, "Taproot-Delivery-Id": event.id, "Taproot-Event": event.type, "Taproot-Installation-Id": event.installationId },
    body, signingSecrets: { [vector.keyId]: vector.signingSecretBase64 }, now: vector.timestamp * 1000,
  });
  let saved;
  const result = await claimWebhookReceipt({
    store: { claim: (receipt) => { saved = receipt; return { state: "claimed", token: "transaction-token" }; } },
    verified,
    now: vector.timestamp * 1000,
  });

  assert.equal(result.state, "claimed");
  assert.equal(saved.deliveryId, verified.deliveryId);
  assert.equal(saved.bodySha256, verified.bodySha256);
  assert.equal(saved.integrationId, verified.event.integrationId);
});

test("receipt completion carries the claim token and immutable hash, while stores retain duplicate states", async () => {
  const vector = JSON.parse(await readFile(new URL("signature-vector.json", root), "utf8"));
  const body = new Uint8Array(await readFile(new URL(vector.bodyFile, root)));
  const event = JSON.parse(new TextDecoder().decode(body));
  const verified = verifyWebhookSignature({
    headers: { "Taproot-Signature": vector.header, "Taproot-Delivery-Id": event.id, "Taproot-Event": event.type, "Taproot-Installation-Id": event.installationId },
    body, signingSecrets: { [vector.keyId]: vector.signingSecretBase64 }, now: vector.timestamp * 1000,
  });
  const finished = [];
  const store = {
    claim: () => ({ state: "claimed", token: "durable-lease-token" }),
    finish: (completion) => { finished.push(completion); },
  };
  const claimed = await claimWebhookReceipt({ store, verified, now: vector.timestamp * 1000 });
  await finishWebhookReceipt({ store, verified, token: claimed.token, status: "failed", failureCode: "downstream_timeout", now: vector.timestamp * 1000 + 1 });
  assert.deepEqual(finished, [{
    deliveryId: verified.deliveryId, bodySha256: verified.bodySha256, token: "durable-lease-token", status: "failed",
    failureCode: "downstream_timeout", completedAt: new Date(vector.timestamp * 1000 + 1).toISOString(),
  }]);

  const duplicate = await claimWebhookReceipt({ store: { claim: () => ({ state: "duplicate" }) }, verified });
  const inProgress = await claimWebhookReceipt({ store: { claim: () => ({ state: "in_progress" }) }, verified });
  const conflict = await claimWebhookReceipt({ store: { claim: () => ({ state: "conflict" }) }, verified });
  assert.equal(duplicate.state, "duplicate");
  assert.equal(inProgress.state, "in_progress");
  assert.equal(conflict.state, "conflict");
});


test("public webhook schemas and examples resolve through the package export contract", async () => {
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith(".json")) continue;
    const resolved = import.meta.resolve(`@taprootio/integration-sdk/fixtures/webhooks/v1/${name}`);
    assert.equal(await readFile(new URL(resolved), "utf8"), await readFile(new URL(name, root), "utf8"));
  }
});
