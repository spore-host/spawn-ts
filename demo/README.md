# spawn-ts BYOA demos

Two demos of the operating models that underpin the spore.host bring-your-own-account
(BYOA) idea — the small-scale rehearsal of the future Arpeggio portal.

| | Who holds the credential | Who controls the instance | Where it runs |
|---|---|---|---|
| **Demo 1 — direct** | You (pasted into the browser) | You | Your account |
| **Demo 2 — portal** | The portal (its own identity) | The portal | Your account (BYOA) |

The through-line: **Demo 1 = infra hosts, you drive. Demo 2 = infra drives, into your
account.** In both, the instance's `spored` daemon registers DNS with spore.host infra
(the "trust with infra") and **self-terminates on its TTL** — the guarantee is identical;
only *who holds the credential and controls the box* changes.

---

## Demo 1 — direct (your account, you drive)

`demo/direct/` — a guided view over the same library the main app uses
(`SpawnClient` + `EC2Provider`). You paste your own AWS credentials, and it:

1. verifies them with STS `GetCallerIdentity` (and reads your account id),
2. shows the exact `{name}.{base36(accountId)}.spore.host` name `spored` will register
   against the real infra DNS Lambda,
3. launches a real `t4g.nano` with a short TTL into **your** account, and
4. polls until `spored` self-terminates it.

You own the instance. Infra's only role here is hosting the UI + running the DNS registry.

### Proving the "trust with infra" end-to-end

DNS registration is instance-side — `spored` reads the instance's IMDS identity and
SigV4-signs a request to the infra DNS Lambda; the browser can't observe that directly.
Demo 1 proves it happened anyway: once the instance has a public IP, it resolves the
computed `{name}.{base36(account)}.spore.host` over public **DNS-over-HTTPS** and checks
that it points at the instance's public IP. When it matches, the "DNS trust" row turns
green — that's live confirmation that `spored` registered with infra. (You can also
confirm out-of-band by resolving the name yourself, or reading the spored journal on the
box for `✓ DNS registered`.)

> **Known infra issue (spawn#435):** the infra DNS Function URL has moved to
> `AuthType: AWS_IAM`, and `spored`'s registration requests are currently being rejected
> before they reach the Lambda — so the "DNS trust" row may stay yellow ("not resolvable
> yet") even though the instance is healthy and self-terminates correctly. This is an
> instance-side/infra-cutover matter tracked on the `spawn` repo, not a demo bug: the
> demo faithfully sets `SPORE_DNS_SIGV4=1`, points at real infra, and only turns the row
> green on a genuine match. The self-termination guarantee is unaffected.

### Run

```bash
npx vite demo/direct
```

Open the printed URL. Authenticate one of two ways:

- **Sign in with Globus (no paste)** — shown when the page is opened with Globus + role
  config (see below). You log in with your **institutional identity** (Globus →
  CILogon/InCommon), and the browser exchanges that for short-lived AWS credentials in your
  own account. No keys.
- **Paste AWS credentials** (fallback) — under the "Or paste AWS credentials" disclosure.

Then launch (a `t4g.nano` on a 5-minute TTL costs well under 1¢). The instance
self-terminates on its TTL even if you close the tab.

### No-paste sign-in via Globus (BYOA)

The no-paste path is **Globus Auth (OIDC) → AWS STS `AssumeRoleWithWebIdentity`**, entirely
in the browser (no backend). Globus federates CILogon/InCommon, so it's institution-agnostic:
one Globus app + one AWS trust works for every InCommon school. Enable it by opening the demo
with URL params:

```
demo/direct/?globus_client_id=<globus-client-uuid>&role_arn=<role-arn>&region=us-east-1
```

**One-time operator setup:**

1. **Register a public Globus app** at [developers.globus.org](https://developers.globus.org)
   (free — no subscription). Type: **public client** (native/SPA, no secret). Add the demo's
   URL as a **redirect URI**. Note the **client-ID (UUID)**.
2. **In the target AWS account**, create an IAM OIDC identity provider + a role that trusts it
   (reuse the templates in [`scttfrdmn/aws-oidc-globus-auth`](https://github.com/scttfrdmn/aws-oidc-globus-auth)):
   - OIDC provider URL: **`https://auth.globus.org`**; client-id-list: your Globus client-ID.
   - Role trust policy: `sts:AssumeRoleWithWebIdentity` with
     `StringEquals {"auth.globus.org:aud": "<client-id>"}` and
     `StringLike {"auth.globus.org:sub": "*"}` (optionally tighten with `email_verified` /
     `email` domain / `groups`, and map claims → `PrincipalTag` for per-user attribution).
   - The role needs the EC2 launch + `iam:PassRole` (for `spored-instance-profile`) perms,
     same as any spawn launch.

This "point-to your account" step is the BYOA configuration — one-time per account.

> **Verify at first wire-up:** decode the returned id_token (the demo logs its `aud`/`sub`)
> and confirm `aud` equals your client-ID — that's what the AWS trust checks. AWS accepts
> Globus's RS512-signed tokens.

**Alternative — point directly at a university IdP:** instead of Globus-as-broker, you can
federate a single institution's Shibboleth via SAML (`AssumeRoleWithSAML` + an IAM SAML
provider per institution). Heavier (per-school metadata exchange) and not implemented here;
Globus-as-broker is the recommended default because it abstracts every InCommon IdP behind
one trust.

> **Note:** launching requires the `spored-instance-profile` to exist in the target
> account (it grants the instance the self-terminate + DNS-invoke permissions). It already
> exists in the spore-host dev account.

### Connect a terminal (SSM, no SSH)

Once the instance is `running`, a **Connect terminal (SSM)** button opens a live shell in
the browser over **AWS SSM Session Manager** — no SSH, no port 22, no key. The browser
calls `ssm:StartSession` with your in-memory creds, gets a session-scoped StreamUrl +
token, and opens the SSM data channel directly (rendered with xterm.js). The SSM
data-channel protocol is reimplemented in `demo/lib/ssm/` (the AWS SDK doesn't provide it).
Closing/reset calls `ssm:TerminateSession`.

> Requires the pasted creds to allow **`ssm:StartSession`** + **`ssm:TerminateSession`**,
> and the instance to be SSM-managed — which it is, since `spored-instance-role` carries
> `AmazonSSMManagedInstanceCore`.

---

### Where it ships

`demo/direct` is part of the main Vite multi-page build (`vite.config.ts`), so it
builds into `dist/demo/direct/` and deploys to the live GitHub Pages site alongside
the main app — reachable via the **BYOA demo →** link in the app's topbar, or directly
at `/demo/direct/`.

## Demo 2 — portal (BYOA, the portal drives)

`demo/portal/` — see [portal/README.md](portal/README.md). A small Node portal service
holds an infra identity, assumes a role in your account, and launches compute there that
**only the portal controls** — you reach it through the portal, not directly.
