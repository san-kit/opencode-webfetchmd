import test from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import { resolveZyteApiKey } from "../src/credentials.ts";

function ctxWith(input: {
  connection?: unknown;
  credential?: unknown;
}): Plugin.Context {
  return {
    integration: {
      connection: {
        active: async () => input.connection,
        resolve: async () => input.credential,
      },
    },
  } as unknown as Plugin.Context;
}

test("Zyte: environment variable wins", async (t) => {
  const previous = process.env.ZYTE_API_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYTE_API_KEY;
    else process.env.ZYTE_API_KEY = previous;
  });

  process.env.ZYTE_API_KEY = "env-key";
  assert.equal(await resolveZyteApiKey(ctxWith({})), "env-key");
});

test("Zyte: key credential", async () => {
  const ctx = ctxWith({
    connection: { type: "credential", id: "cred_1", label: "Zyte" },
    credential: { type: "key", key: "stored-key" },
  });

  assert.equal(await resolveZyteApiKey(ctx), "stored-key");
});

test("Zyte: external credential metadata", async () => {
  const ctx = ctxWith({
    connection: { type: "credential", id: "cred_1", label: "Zyte" },
    credential: {
      type: "external",
      methodID: "api-key",
      metadata: { api_key: "metadata-key" },
    },
  });

  assert.equal(await resolveZyteApiKey(ctx), "metadata-key");
});

test("Zyte: not connected", async () => {
  await assert.rejects(
    resolveZyteApiKey(ctxWith({})),
    /Run \/connect, choose "Zyte"/,
  );
});
