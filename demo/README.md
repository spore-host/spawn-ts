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

### Run

```bash
npx vite demo/direct
```

Open the printed URL, paste dev credentials (a `t4g.nano` on a 5-minute TTL costs well
under 1¢), and launch. The instance self-terminates on its TTL even if you close the tab.

> **Note:** launching requires the `spored-instance-profile` to exist in the target
> account (it grants the instance the self-terminate + DNS-invoke permissions). It already
> exists in the spore-host dev account.

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
