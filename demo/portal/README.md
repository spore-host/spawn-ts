# Demo 2 — portal (BYOA, the portal drives)

The Arpeggio compute plane in miniature. A small Node **portal service** holds its
own infra identity, **assumes a role in your account**, and launches compute there
that **only the portal controls** — you reach it through the portal, never directly.

This is the cross-account half of the spore.host model. It mirrors the one place in
the Go codebase that assume-roles then launches — `lambda/autoscale-orchestrator` +
`cloudformation/autoscale-ec2-role.yaml`, ExternalId and all.

```
Browser (portal UI, no credentials)
  → POST /api/launch → Portal service (its own infra identity)
      → sts:AssumeRole into the dev portal-launch role (RoleArn + ExternalId)
      → EC2Provider built from the TEMP creds → SpawnClient.launch(t4g.nano, short TTL)
      → RunInstances in the DEV account
  spored on the instance: registers DNS with infra + self-terminates on TTL
```

The instance runs under the **portal's** assumed role, not yours — so the UI offers
only portal-mediated actions (status, terminate-via-portal). There is deliberately no
credential entry: you don't hold the credential that controls the box.

### Terminal — brokered by the portal

A running instance gets an **Open terminal (via portal)** button. The portal calls
`ssm:StartSession` with its assumed role and hands your browser **only** the
session-scoped `{sessionId, streamUrl, tokenValue}` — never AWS credentials. Your browser
opens the SSM data channel with that token and renders the shell (xterm). This is the
faithful "access is brokered by the portal" model: the portal is the sole authorizer, and
you could not open the session yourself. Closing calls `ssm:TerminateSession`.

Validated live end-to-end: the browser authenticates the SSM WebSocket with the token
message alone (no SigV4 header, which browsers can't send) and runs a real shell —
confirmed `whoami` → `ssm-user`.

## Prerequisites — the dev portal-launch role (one-time IAM)

The portal assumes a role in the compute account (dev, `435415984226`). It must:

- **trust** the portal's infra principal (the identity the portal runs as) with an
  **ExternalId** (confused-deputy guard), and
- grant `ec2:RunInstances`/`TerminateInstances`/`CreateTags`/`Describe*` +
  `iam:PassRole` scoped to `spored-instance-role`.

This is the same shape as the `spawn-ts#38` dev launch role and
`cloudformation/autoscale-ec2-role.yaml`. Creating it is an explicit, approved step
(cross-account IAM) — not done automatically.

## Run

```bash
export AWS_PROFILE=spore-host-infra          # the portal's own identity
export PORTAL_LAUNCH_ROLE_ARN=arn:aws:iam::435415984226:role/<portal-launch-role>
export PORTAL_EXTERNAL_ID=<external-id>
npx tsx demo/portal/server.ts
```

Open `http://localhost:8787`. Click launch — the portal assumes the role and launches
a `t4g.nano` (short TTL, well under 1¢) into the dev account. The browser never
receives AWS credentials.

| Env | Default | Meaning |
|---|---|---|
| `PORTAL_LAUNCH_ROLE_ARN` | *(required)* | Role in the user/dev account the portal assumes |
| `PORTAL_EXTERNAL_ID` | *(required)* | Confused-deputy external id |
| `PORTAL_REGION` | `us-east-1` | Launch region |
| `PORTAL_INSTANCE_PROFILE` | `spored-instance-profile` | Instance profile passed to the launch |
| `PORTAL_PORT` | `8787` | Portal listen port |
