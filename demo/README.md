# spawn-ts BYOA demo

A demo of the operating model that underpins the spore.host bring-your-own-account
(BYOA) idea: **you hold the credential, you control the instance, and it runs in your
account.** The instance's `spored` daemon registers DNS with spore.host infra (the
"trust with infra") and **self-terminates on its TTL**.

There is deliberately no server-side component. The browser holds a short-lived
credential for your own account and calls AWS directly; nothing in between can act
on your account for anyone else. (An earlier "Demo 2", a hosted portal service that
held an account credential and launched, terminated and opened shells on callers'
behalf, has been removed. A broker like that needs authenticated callers and a
per-instance ownership check on every action, which a demo does not provide. The
spore.host portal, `spore-host/web/portal`, is built the same way as this demo:
BYOA in the browser, no broker.)

---

## Direct (your account, you drive)

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
The demo proves it happened anyway: once the instance has a public IP, it resolves the
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
   (the templates in [`scttfrdmn/aws-oidc-globus-auth`](https://github.com/scttfrdmn/aws-oidc-globus-auth)
   are a starting point; spore-host's `infra/tofu/portal-oidc` module is the reference for
   the trust below):
   - OIDC provider URL: **`https://auth.globus.org`**; client-id-list: your Globus client-ID.
   - Role trust policy: `sts:AssumeRoleWithWebIdentity`, with **both** `aud` pinned to your
     client-ID **and** `sub` pinned to the Globus identity UUIDs of the people allowed to
     launch:

     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/auth.globus.org" },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "auth.globus.org:aud": "<client-id>",
             "auth.globus.org:sub": ["<globus-identity-uuid>", "<another-globus-identity-uuid>"]
           }
         }
       }]
     }
     ```

     `StringEquals` with a list matches any one entry in it; it is not a pattern. Look up
     a person's identity UUID with `globus get-identities <username>` (for example
     `globus get-identities someone@example.edu`). To add a user, append their UUID.
   - The role needs the EC2 launch + `iam:PassRole` (for `spored-instance-profile`) perms,
     same as any spawn launch. Scope them the way `portal-oidc` does: instance actions
     conditioned on `aws:ResourceTag/spawn:managed`, and `iam:PassRole` limited to the
     spored instance role with `iam:PassedToService = ec2.amazonaws.com`.

   > **Never trust a wildcard `sub`** (`StringLike {"auth.globus.org:sub": "*"}`, or no
   > `sub` condition at all). Anyone can get a Globus identity for free (Globus ID,
   > Google, ORCID, GitHub and others), and the `aud` check proves nothing about *who*
   > signed in: your client-ID is public, because it is in the page URL and the bundle,
   > and any Globus user who completes your public-client sign-in gets a token with that
   > `aud`. A wildcard `sub` therefore lets anyone on the internet assume a role that can
   > launch EC2 instances and pass a role to them, at your expense.
   >
   > **Don't try to narrow the trust by `email`, `email_verified` or `groups`.** IAM does
   > not expose those claims of a generic OIDC provider such as Globus as condition keys;
   > `aud` and `sub` are what a trust policy can check. A condition on an email domain
   > or a group therefore cannot express "only these people". Pin `sub`.

This "point-to your account" step is the BYOA configuration — one-time per account.
If you also registered the client-ID on an OIDC provider that a looser role trusts, retire
that role or remove the client-ID from the provider's client-id-list.

> **Verify at first wire-up:** decode the returned id_token (the demo logs its `aud`/`sub`)
> and confirm `aud` equals your client-ID and `sub` is one of the UUIDs you pinned —
> those are what the AWS trust checks. AWS accepts
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
