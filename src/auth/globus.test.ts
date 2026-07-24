// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { beginLogin, completeLogin, hasAuthCode, codeChallengeS256, decodeJwtPayload } from "./globus.js";

const CFG = { clientId: "client-uuid-123", redirectUri: "https://demo.example/direct/" };

function makeJwt(payload: Record<string, unknown>): string {
  const b64u = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64u({ alg: "RS512", typ: "JWT" })}.${b64u(payload)}.sig`;
}

describe("codeChallengeS256", () => {
  it("derives the known RFC-7636 challenge for the sample verifier", async () => {
    // RFC 7636 Appendix B test vector.
    const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await codeChallengeS256(v)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("beginLogin", () => {
  beforeEach(() => sessionStorage.clear());

  it("builds an authorize URL with PKCE + state and stashes the verifier", async () => {
    const url = await beginLogin(CFG, false);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://auth.globus.org/v2/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("client-uuid-123");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.redirectUri);
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    const state = u.searchParams.get("state");
    expect(state).toBeTruthy();
    // stashed for completeLogin
    expect(sessionStorage.getItem("globus.pkce.state")).toBe(state);
    expect(sessionStorage.getItem("globus.pkce.verifier")).toBeTruthy();
    // the stashed verifier must actually produce the challenge in the URL
    const verifier = sessionStorage.getItem("globus.pkce.verifier")!;
    expect(await codeChallengeS256(verifier)).toBe(u.searchParams.get("code_challenge"));
  });
});

describe("hasAuthCode", () => {
  it("detects a redirect-back", () => {
    expect(hasAuthCode("?code=abc&state=xyz")).toBe(true);
    expect(hasAuthCode("?code=abc")).toBe(false);
    expect(hasAuthCode("")).toBe(false);
  });
});

describe("completeLogin", () => {
  beforeEach(() => sessionStorage.clear());

  function armState(state = "the-state") {
    sessionStorage.setItem("globus.pkce.state", state);
    sessionStorage.setItem("globus.pkce.verifier", "the-verifier");
  }
  function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
    return vi.fn().mockResolvedValue({ ok, status, json: () => Promise.resolve(body) }) as unknown as typeof fetch;
  }

  it("validates state, exchanges the code with PKCE + no secret, returns the id_token", async () => {
    armState();
    const idToken = makeJwt({ sub: "u1", aud: "client-uuid-123", email: "a@ucla.edu" });
    const f = fakeFetch({ access_token: "at", id_token: idToken, resource_server: "auth.globus.org" });
    const tokens = await completeLogin(CFG, "?code=THECODE&state=the-state", f);

    expect(tokens.idToken).toBe(idToken);
    expect(tokens.claims.aud).toBe("client-uuid-123"); // the wire-up check surfaces aud
    // the token POST used the verifier + client_id, NO secret
    const [, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = new URLSearchParams((init as RequestInit).body as string);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("THECODE");
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(sent.get("client_id")).toBe("client-uuid-123");
    expect(sent.has("client_secret")).toBe(false);
    // one-time values cleared
    expect(sessionStorage.getItem("globus.pkce.state")).toBeNull();
  });

  it("rejects a state mismatch (CSRF) before calling the token endpoint", async () => {
    armState("expected");
    const f = fakeFetch({});
    await expect(completeLogin(CFG, "?code=x&state=ATTACKER", f)).rejects.toThrow(/state mismatch/);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("extracts the id_token from other_tokens when nested", async () => {
    armState();
    const idToken = makeJwt({ aud: "client-uuid-123" });
    const f = fakeFetch({
      access_token: "at",
      resource_server: "transfer.api.globus.org",
      other_tokens: [{ resource_server: "auth.globus.org", id_token: idToken }],
    });
    const tokens = await completeLogin(CFG, "?code=c&state=the-state", f);
    expect(tokens.idToken).toBe(idToken);
  });

  it("throws when no id_token is present (missing openid scope)", async () => {
    armState();
    const f = fakeFetch({ access_token: "at", resource_server: "auth.globus.org" });
    await expect(completeLogin(CFG, "?code=c&state=the-state", f)).rejects.toThrow(/no id_token/);
  });
});

describe("decodeJwtPayload", () => {
  it("decodes the payload segment", () => {
    const jwt = makeJwt({ sub: "abc", aud: "client-uuid-123" });
    expect(decodeJwtPayload(jwt)).toMatchObject({ sub: "abc", aud: "client-uuid-123" });
  });
  it("throws on a malformed token", () => {
    expect(() => decodeJwtPayload("notajwt")).toThrow(/malformed JWT/);
  });
});
