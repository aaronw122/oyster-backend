/** Decrypted token material for one user + provider. Never logged, never put in errors. */
export type StoredToken = { accessToken: string; refreshToken?: string; expiresAt?: string };

/**
 * One pre-registered OAuth provider. `codeVerifier` is the PKCE verifier the routes
 * generate and keep server-side (bound to the state nonce); adapters that don't use
 * PKCE ignore it.
 */
export interface OAuthProviderAdapter {
  id: string;
  displayName: string;
  authorizeUrl(ctx: { state: string; redirectUri: string; codeVerifier?: string }): Promise<string>;
  exchange(ctx: { query: URLSearchParams; redirectUri: string; codeVerifier?: string }): Promise<StoredToken>;
  refresh?(token: StoredToken): Promise<StoredToken>;
}

/** Machine codes carried on the `oyster://oauth/complete?...&code=` redirect. */
export type OAuthErrorCode =
  | "invalid_state"
  | "state_expired"
  | "state_reused"
  | "provider_mismatch"
  | "access_denied"
  | "provider_error"
  | "missing_code"
  | "exchange_failed"
  | "refresh_failed";

/** Failure with a stable code and a message that never contains token material or provider bodies. */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}
