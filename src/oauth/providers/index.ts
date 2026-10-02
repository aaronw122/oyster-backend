import { oauth2Adapter } from "../oauth2.ts";
import type { OAuthProviderAdapter } from "../types.ts";

export type OAuthEnv = Record<string, string | undefined>;
export type ProviderFactory = (env: OAuthEnv) => OAuthProviderAdapter | null;

/** `OAUTH_<ID>_CLIENT_ID` / `OAUTH_<ID>_CLIENT_SECRET`, or null unless both are set. */
function clientCredentials(env: OAuthEnv, id: string): { clientId: string; clientSecret: string } | null {
  const key = id.toUpperCase();
  const clientId = env[`OAUTH_${key}_CLIENT_ID`]?.trim();
  const clientSecret = env[`OAUTH_${key}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// Pre-registered, read-only data providers. Every scope below grants read access
// only — never write/post/transact (plan DON'T). A provider is enabled only when
// its client credentials are present in the environment.
export const PROVIDER_FACTORIES: ProviderFactory[] = [
  (env) => {
    const creds = clientCredentials(env, "github");
    return (
      creds &&
      oauth2Adapter({
        id: "github",
        displayName: "GitHub",
        apiOrigins: ["https://api.github.com"],
        authorizeEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        ...creds,
        scopes: ["read:user"],
        extraAuthorizeParams: { allow_signup: "false" },
      })
    );
  },
  (env) => {
    const creds = clientCredentials(env, "google");
    return (
      creds &&
      oauth2Adapter({
        id: "google",
        displayName: "Google",
        apiOrigins: ["https://www.googleapis.com", "https://tasks.googleapis.com"],
        authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        ...creds,
        scopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/tasks.readonly",
        ],
        // Offline access + consent so Google issues a refresh token.
        extraAuthorizeParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "false" },
      })
    );
  },
  (env) => {
    const creds = clientCredentials(env, "spotify");
    return (
      creds &&
      oauth2Adapter({
        id: "spotify",
        displayName: "Spotify",
        apiOrigins: ["https://api.spotify.com"],
        authorizeEndpoint: "https://accounts.spotify.com/authorize",
        tokenEndpoint: "https://accounts.spotify.com/api/token",
        ...creds,
        clientAuth: "basic",
        scopes: [
          "user-read-currently-playing",
          "user-read-playback-state",
          "user-read-recently-played",
          "user-top-read",
        ],
      })
    );
  },
  (env) => {
    const creds = clientCredentials(env, "strava");
    return (
      creds &&
      oauth2Adapter({
        id: "strava",
        displayName: "Strava",
        apiOrigins: ["https://www.strava.com"],
        authorizeEndpoint: "https://www.strava.com/oauth/authorize",
        tokenEndpoint: "https://www.strava.com/oauth/token",
        ...creds,
        // Strava doesn't support PKCE and separates scopes with commas.
        pkce: false,
        scopeSeparator: ",",
        scopes: ["read", "activity:read"],
        extraAuthorizeParams: { approval_prompt: "auto" },
      })
    );
  },
];

/** Builds every provider whose credentials are configured, keyed by id. */
export function loadProviders(env: OAuthEnv): Map<string, OAuthProviderAdapter> {
  const providers = new Map<string, OAuthProviderAdapter>();
  for (const factory of PROVIDER_FACTORIES) {
    const adapter = factory(env);
    if (adapter) providers.set(adapter.id, adapter);
  }
  return providers;
}
