export { type OAuth2Config, codeChallenge, createCodeVerifier, oauth2Adapter } from "./oauth2.ts";
export { loadProviders, type OAuthEnv, PROVIDER_FACTORIES, type ProviderFactory } from "./providers/index.ts";
export {
  createOAuthStartUrl,
  OAuthNonceStore,
  oauthRedirectUri,
  STATE_TTL_MS,
  type StatePayload,
  signState,
  type VerifiedState,
  verifyState,
} from "./state.ts";
export { OAuthTokenStore } from "./tokens.ts";
export { OAuthError, type OAuthErrorCode, type OAuthProviderAdapter, type StoredToken } from "./types.ts";

import type { OAuthTokenStore } from "./tokens.ts";
import type { OAuthProviderAdapter } from "./types.ts";

/** What the server needs to run the OAuth routes (`AppDeps.oauth`). */
export type OAuthDeps = {
  providers: Map<string, OAuthProviderAdapter>;
  tokens: OAuthTokenStore;
  now?: () => number;
};
