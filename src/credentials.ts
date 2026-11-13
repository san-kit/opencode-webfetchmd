import type { Plugin } from "@opencode/plugin";

/**
 * The integration ID is namespaced so a future built-in integration with the
 * same name cannot collide with this plugin.
 */
export const ZYTE_INTEGRATION_ID = "zyte";

/**
 * Registers the Zyte integration.
 *
 * A key method without a form gives the user a single "API key" prompt in
 * `/connect`, which is exactly what Zyte needs. The key is stored by
 * OpenCode's credential store, not by this plugin.
 */
export async function registerZyteIntegration(
  ctx: Plugin.Context,
): Promise<void> {
  await ctx.integration.transform((editor) => {
    editor.update(ZYTE_INTEGRATION_ID, (integration) => {
      integration.name = "Zyte";
    });

    editor.method.update({
      integrationID: ZYTE_INTEGRATION_ID,
      method: {
        type: "key",
        label: "Zyte API key",
      },
    });
  });
}

/**
 * Resolves the Zyte API key in this order:
 *
 * 1. `ZYTE_API_KEY` environment variable (CI).
 * 2. The active `zyte` connection created through `/connect`.
 *
 * If none is available, the tool returns a clear error instead of making a
 * request.
 */
export async function resolveZyteApiKey(ctx: Plugin.Context): Promise<string> {
  const envKey = process.env.ZYTE_API_KEY?.trim();
  if (envKey) return envKey;

  const connection =
    await ctx.integration.connection.active(ZYTE_INTEGRATION_ID);
  if (connection) {
    const credential = await ctx.integration.connection.resolve(connection);

    if (credential?.type === "key") {
      const apiKey = credential.key.trim();
      if (apiKey) return apiKey;
    }

    if (credential?.type === "external") {
      const apiKey =
        typeof credential.metadata?.api_key === "string"
          ? credential.metadata.api_key.trim()
          : "";
      if (apiKey) return apiKey;
    }
  }

  throw new Error(
    `webfetchmd is not connected. Run /connect, choose "Zyte", and enter your API key. ` +
      `Alternatively set ZYTE_API_KEY. Do not retry until configured.`,
  );
}
