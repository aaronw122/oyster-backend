import { createHmac } from "node:crypto";
import { z } from "zod";
import { OAuthError, type OAuthProviderAdapter } from "../types.ts";

// Plaid API over plain fetch (JSON POST; client_id + secret in the body).
// Docs: https://plaid.com/docs/link/hosted-link/, https://plaid.com/docs/api/link/,
// https://plaid.com/docs/api/items/, https://plaid.com/docs/api/products/balance/

export type PlaidEnvironment = "sandbox" | "production";

export const PLAID_BASE_URLS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export type PlaidConfig = {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
};

/**
 * `PLAID_CLIENT_ID` + `PLAID_SECRET` (+ `PLAID_ENV`: sandbox | production, default sandbox),
 * or null unless both credentials are set. An unknown `PLAID_ENV` throws: silently
 * pointing production credentials at the wrong environment must not happen.
 */
export function plaidConfigFromEnv(env: Record<string, string | undefined>): PlaidConfig | null {
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  if (!clientId || !secret) return null;
  const environment = env.PLAID_ENV?.trim().toLowerCase() || "sandbox";
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(`PLAID_ENV must be "sandbox" or "production"`);
  }
  return { clientId, secret, environment };
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A failed Plaid call. Carries only Plaid's machine codes (e.g. `ITEM_LOGIN_REQUIRED`)
 * and the HTTP status: never the request (secret, tokens) or Plaid's free-text messages.
 */
export class PlaidApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly errorType: string | null,
    readonly errorCode: string | null,
    readonly status: number | null,
  ) {
    const reason = errorCode ?? (status === null ? "no response" : `HTTP ${status}`);
    super(`Plaid ${endpoint} failed: ${reason}`);
    this.name = "PlaidApiError";
  }
}

// Plaid error codes/types are UPPER_SNAKE enums; anything else isn't echoed.
const machineCode = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null;

/** POSTs `body` plus credentials to `endpoint`; returns the parsed JSON or throws `PlaidApiError`. */
export async function plaidRequest(
  config: PlaidConfig,
  endpoint: string,
  body: Record<string, unknown>,
  doFetch: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await doFetch(`${PLAID_BASE_URLS[config.environment]}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PlaidApiError(endpoint, null, null, null);
  }
  const json: unknown = await res.json().catch(() => null);
  const record = typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  if (!res.ok || !record) {
    throw new PlaidApiError(endpoint, machineCode(record?.error_type), machineCode(record?.error_code), res.status);
  }
  return record;
}

/**
 * Opaque, stable Plaid `client_user_id` for an Oyster user: an HMAC of the user id,
 * so Plaid never sees the id (or an email) and it can't be reversed without the secret.
 */
export function plaidClientUserId(config: PlaidConfig, userId: string): string {
  return createHmac("sha256", config.secret).update(`oyster-plaid-user:${userId}`).digest("base64url");
}

type PublicTokenLookup = { status: "success"; publicToken: string } | { status: "exited"; error: boolean } | { status: "pending" };

const publicTokenField = z.object({ public_token: z.string().min(1) });
const LinkTokenGetResponse = z.object({
  link_sessions: z
    .array(
      z.object({
        // `results.item_add_results` is the current field; `on_success` is the legacy one.
        results: z.object({ item_add_results: z.array(publicTokenField.partial()).nullish() }).nullish(),
        on_success: publicTokenField.partial().nullish(),
        on_exit: z.object({ error: z.unknown() }).partial().nullish(),
      }),
    )
    .nullish(),
});

/** Reads the Hosted Link session outcome from a `/link/token/get` response. */
function publicTokenFrom(linkTokenGet: unknown): PublicTokenLookup {
  const parsed = LinkTokenGetResponse.safeParse(linkTokenGet);
  let exited: PublicTokenLookup | null = null;
  for (const session of (parsed.success && parsed.data.link_sessions) || []) {
    const publicToken =
      session.results?.item_add_results?.find((result) => result.public_token)?.public_token ?? session.on_success?.public_token;
    if (publicToken) return { status: "success", publicToken };
    if (session.on_exit) exited = { status: "exited", error: session.on_exit.error !== null && session.on_exit.error !== undefined };
  }
  return exited ?? { status: "pending" };
}

export type PlaidAdapterOptions = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** `/link/token/get` attempts while the just-finished session isn't recorded yet. Default 4. */
  sessionPollAttempts?: number;
  sessionPollDelayMs?: number;
};

export const PLAID_DISPLAY_NAME = "your bank";

/**
 * Plaid Hosted Link as an OAuth-style provider. /start creates a link token whose
 * Hosted Link completion redirect is our callback (carrying the opaque state nonce)
 * and stores the link token on that nonce; /callback reads the session's public
 * token via `/link/token/get` and exchanges it for a non-expiring access token.
 * Plaid calls the completion redirect on success and on exit, so the outcome always
 * comes from `/link/token/get`, never from the redirect's query.
 */
export function plaidAdapter(config: PlaidConfig, options: PlaidAdapterOptions = {}): OAuthProviderAdapter {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, options.sessionPollAttempts ?? 4);
  const delayMs = options.sessionPollDelayMs ?? 750;

  return {
    id: "plaid",
    displayName: PLAID_DISPLAY_NAME,

    async authorizeUrl({ state, redirectUri, userId, saveFlowData }) {
      const failure = new OAuthError("provider_error", "Couldn't start connecting your bank.");
      if (!userId || !saveFlowData) throw failure;
      const completion = new URL(redirectUri);
      completion.searchParams.set("state", state);
      let created: Record<string, unknown>;
      try {
        created = await plaidRequest(
          config,
          "/link/token/create",
          {
            client_name: "Oyster",
            language: "en",
            country_codes: ["US"],
            user: { client_user_id: plaidClientUserId(config, userId) },
            // Balance can't be requested directly and is initialized with any other
            // product; transactions covers checking, savings and credit cards.
            products: ["transactions"],
            hosted_link: { completion_redirect_uri: completion.toString(), is_mobile_app: true },
          },
          doFetch,
        );
      } catch (err) {
        console.error(`[oauth plaid] ${err instanceof Error ? err.message : "link token create failed"}`);
        throw failure;
      }
      const { link_token: linkToken, hosted_link_url: hostedLinkUrl } = created;
      if (typeof linkToken !== "string" || typeof hostedLinkUrl !== "string" || !hostedLinkUrl.startsWith("https://")) {
        throw failure;
      }
      saveFlowData(linkToken);
      return hostedLinkUrl;
    },

    async exchange({ flowData }) {
      const failure = new OAuthError("exchange_failed", "Couldn't finish connecting your bank.");
      if (!flowData) throw failure;
      try {
        let lookup: PublicTokenLookup = { status: "pending" };
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (attempt > 0) await sleep(delayMs);
          lookup = publicTokenFrom(await plaidRequest(config, "/link/token/get", { link_token: flowData }, doFetch));
          if (lookup.status !== "pending") break;
        }
        if (lookup.status === "exited") {
          throw lookup.error
            ? new OAuthError("provider_error", "Your bank couldn't be connected.")
            : new OAuthError("access_denied", "Connecting your bank was cancelled.");
        }
        if (lookup.status === "pending") throw failure;

        const exchanged = await plaidRequest(config, "/item/public_token/exchange", { public_token: lookup.publicToken }, doFetch);
        if (typeof exchanged.access_token !== "string" || exchanged.access_token === "") throw failure;
        // Plaid access tokens don't expire; a broken login surfaces as ITEM_LOGIN_REQUIRED.
        return { accessToken: exchanged.access_token };
      } catch (err) {
        if (err instanceof OAuthError) throw err;
        console.error(`[oauth plaid] ${err instanceof Error ? err.message : "exchange failed"}`);
        throw failure;
      }
    },
  };
}
