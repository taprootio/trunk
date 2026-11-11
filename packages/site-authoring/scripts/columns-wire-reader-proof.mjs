import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { getPage } from "../src/api.js";
import { LIMITS } from "../src/constants.js";
import { SiteApiClient } from "../src/transport.js";

export const COLUMNS_WIRE_PROOF_PAGE_ID = "7fc89589-e730-4a8f-a0f8-5668b09d51c0";

function measureBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("The wire proof requires a free-form page response.");
    error.code = "proof.page_shape";
    throw error;
  }
  let nodeDepth = 0;
  const nodes = [{ value: body, depth: 0 }];
  while (nodes.length > 0) {
    const { value, depth } = nodes.pop();
    nodeDepth = Math.max(nodeDepth, depth);
    if (Array.isArray(value?.content)) {
      for (const child of value.content) nodes.push({ value: child, depth: depth + 1 });
    }
  }
  let containerDepth = 0;
  const containers = [{ value: body, depth: 1 }];
  while (containers.length > 0) {
    const { value, depth } = containers.pop();
    if (value === null || typeof value !== "object") continue;
    containerDepth = Math.max(containerDepth, depth);
    for (const child of Object.values(value)) containers.push({ value: child, depth: depth + 1 });
  }
  return {
    reencodedBodyBytes: Buffer.byteLength(JSON.stringify(body)),
    bodyNodeDepth: nodeDepth,
    bodyContainerDepth: containerDepth,
  };
}

function waitForDrain(response) {
  if (response.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}

/**
 * Replays supplied response bytes over a private loopback stream through the
 * existing getPage operation and bounded reader. It changes no fetch, parser,
 * origin allowlist or response limit. onFirstChunk is only a cancellation seam
 * for the real HTTP fixture; it does not replace any client operation.
 */
export async function readColumnsWireResponse(bytes, { signal, onFirstChunk } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Response bytes must be a Uint8Array.");
  const payload = Buffer.from(bytes);
  let requests = 0;
  const route = `/api/v1/pages/${COLUMNS_WIRE_PROOF_PAGE_ID}?status=PAGE_STATUS_DRAFT`;
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== route) {
      response.writeHead(404).end();
      return;
    }
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    try {
      for (let offset = 0; offset < payload.byteLength && !response.destroyed; offset += 16 * 1024) {
        const chunk = payload.subarray(offset, offset + 16 * 1024);
        const drained = response.write(chunk);
        if (offset === 0) await onFirstChunk?.();
        if (!drained) await waitForDrain(response);
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!response.destroyed) response.end();
    } catch {
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = new SiteApiClient({
      apiBaseUrl: `http://127.0.0.1:${server.address().port}/api`,
      token: "columns-wire-proof-only",
      signal,
    });
    const page = await getPage(client, COLUMNS_WIRE_PROOF_PAGE_ID, "PAGE_STATUS_DRAFT");
    return {
      page,
      metrics: {
        responseBytes: payload.byteLength,
        readerLimitBytes: LIMITS.apiResponseBytes,
        requests,
        ...measureBody(page.template?.freeFormData?.body),
      },
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main() {
  if (process.argv.length !== 3) {
    process.stderr.write("Usage: node columns-wire-reader-proof.mjs <captured-response.json>\n");
    process.exitCode = 2;
    return;
  }
  let bytes;
  try {
    bytes = await readFile(process.argv[2]);
    const { metrics } = await readColumnsWireResponse(bytes);
    process.stdout.write(`${JSON.stringify({ status: "accepted", ...metrics })}\n`);
  } catch (error) {
    process.stdout.write(`${
      JSON.stringify({
        status: "refused",
        code: typeof error?.code === "string" ? error.code : "proof.failed",
        ...(bytes ? { responseBytes: bytes.byteLength } : {}),
        readerLimitBytes: LIMITS.apiResponseBytes,
      })
    }\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
