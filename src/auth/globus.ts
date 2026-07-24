// Browser-native Globus Auth OIDC (authorization-code + PKCE) — the no-paste
// sign-in for BYOA. Globus federates CILogon/InCommon, so a user signs in with
// their normal university identity and we get an OIDC id_token that AWS STS
// (AssumeRoleWithWebIdentity) exchanges for short-lived creds — no backend, no
// secret, no pasted keys.
//
// Endpoints are hardcoded (Globus's OIDC discovery doc understates PKCE support,
// so we don't trust it): verified live —
//   issuer  https://auth.globus.org
//   authorize https://auth.globus.org/v2/oauth2/authorize
//   token     https://auth.globus.org/v2/oauth2/token   (CORS: ACAO *)
//   id_token_signing_alg RS512 (AWS STS accepts it)

const AUTHORIZE_URL = "https://auth.globus.org/v2/oauth2/authorize";
const TOKEN_URL = "https://auth.globus.org/v2/oauth2/token";
const GLOBUS_RESOURCE_SERVER = "auth.globus.org";
const DEFAULT_SCOPE = "openid profile email";

const SS_VERIFIER = "globus.pkce.verifier";
const SS_STATE = "globus.pkce.state";

export interface GlobusConfig {
  /** The registered Globus public-client UUID. Must match the AWS trust's aud. */
  clientId: string;
  /** Redirect URI = this page's URL (must be allowlisted on the Globus app). */
  redirectUri: string;
  /** OAuth scopes; default "openid profile email". */
  scope?: string;
  /**
   * Force the Globus identity-provider chooser every time. Globus skips the
   * "pick your institution/IdP" screen and jumps to consent when you already
   * have an active session; prompt=login re-prompts. Good for demos that want to
   * show the CILogon/InCommon university picker.
   */
  forcePrompt?: boolean;
}

const enc = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64UrlEncode(a);
}

/** PKCE S256 challenge for a verifier (WebCrypto SHA-256, base64url). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return base64UrlEncode(digest);
}

/**
 * Begin login: generate + stash a PKCE verifier and CSRF state, then redirect the
 * browser to Globus's authorize endpoint. Returns the URL (also performs the
 * redirect unless `redirect` is false — testable).
 */
export async function beginLogin(cfg: GlobusConfig, redirect = true): Promise<string> {
  const verifier = randomString();
  const state = randomString(16);
  sessionStorage.setItem(SS_VERIFIER, verifier);
  sessionStorage.setItem(SS_STATE, state);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope ?? DEFAULT_SCOPE,
    state,
    code_challenge: await codeChallengeS256(verifier),
    code_challenge_method: "S256",
  });
  // Re-prompt for identity selection (show the IdP picker) instead of reusing an
  // existing Globus session and jumping straight to consent.
  if (cfg.forcePrompt) params.set("prompt", "login");
  const url = `${AUTHORIZE_URL}?${params.toString()}`;
  if (redirect) window.location.assign(url);
  return url;
}

/** True when the current URL is an OAuth redirect-back (has ?code= & ?state=). */
export function hasAuthCode(search = window.location.search): boolean {
  const p = new URLSearchParams(search);
  return p.has("code") && p.has("state");
}

export interface GlobusTokens {
  idToken: string;
  accessToken?: string;
  /** Decoded id_token claims (unverified — for display + the aud wire-up check). */
  claims: Record<string, unknown>;
}

/**
 * Complete login on redirect-back: validate state, exchange the code (with the
 * stashed PKCE verifier, no client secret), and return the OIDC id_token. The
 * id_token lives in the auth.globus.org resource-server section of the response.
 * `fetchImpl` + `search` are injectable for testing.
 */
export async function completeLogin(
  cfg: GlobusConfig,
  search = window.location.search,
  fetchImpl: typeof fetch = fetch,
): Promise<GlobusTokens> {
  const p = new URLSearchParams(search);
  const code = p.get("code");
  const returnedState = p.get("state");
  if (!code) throw new Error("no authorization code in redirect");

  const expectedState = sessionStorage.getItem(SS_STATE);
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("state mismatch (possible CSRF) — aborting token exchange");
  }
  const verifier = sessionStorage.getItem(SS_VERIFIER);
  if (!verifier) throw new Error("missing PKCE verifier (login not initiated here)");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Globus token exchange failed: ${res.status}`);
  const data = (await res.json()) as GlobusTokenResponse;

  sessionStorage.removeItem(SS_VERIFIER);
  sessionStorage.removeItem(SS_STATE);

  const idToken = extractIdToken(data);
  if (!idToken) throw new Error("no id_token in Globus token response (need scope=openid)");
  return { idToken, accessToken: data.access_token, claims: decodeJwtPayload(idToken) };
}

// Globus returns per-resource-server tokens; the OIDC id_token accompanies the
// auth.globus.org token, either at the top level or nested in other_tokens.
interface GlobusTokenResponse {
  access_token?: string;
  id_token?: string;
  resource_server?: string;
  other_tokens?: GlobusTokenResponse[];
  [k: string]: unknown;
}

function extractIdToken(data: GlobusTokenResponse): string | undefined {
  if (data.id_token && data.resource_server === GLOBUS_RESOURCE_SERVER) return data.id_token;
  if (data.id_token && !data.resource_server) return data.id_token;
  if (data.id_token) return data.id_token;
  const nested = data.other_tokens?.find((t) => t.resource_server === GLOBUS_RESOURCE_SERVER && t.id_token);
  return nested?.id_token;
}

/** Decode (not verify) a JWT payload. Signature verification is STS's job. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("malformed JWT");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return JSON.parse(json) as Record<string, unknown>;
}
