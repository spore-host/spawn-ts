// Resolve a hostname over DNS-over-HTTPS (DoH) from the browser.
//
// Demo 1 uses this to PROVE the "trust with infra" end-to-end: after launch, the
// instance's spored registers {name}.{base36(account)}.spore.host with the infra
// DNS Lambda (an instance-side action the browser can't observe directly). By
// resolving that name over public DoH and seeing it point at the instance's
// public IP, the browser confirms the registration actually happened.
//
// Cloudflare's DoH JSON endpoint is CORS-enabled, so it works from a page.

export interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

/** DNS record type numbers we care about (A = IPv4 address record). */
export const DNS_TYPE_A = 1;

/**
 * Resolve `name` over DoH and return the A-record IPs (may be empty if the name
 * doesn't resolve yet). `fetchImpl` is injectable for testing. Never throws on a
 * DNS miss — returns []; only throws if the HTTP call itself fails.
 */
export async function resolveA(
  name: string,
  fetchImpl: typeof fetch = fetch,
  endpoint = "https://cloudflare-dns.com/dns-query",
): Promise<string[]> {
  const url = `${endpoint}?name=${encodeURIComponent(name)}&type=A`;
  const res = await fetchImpl(url, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH query failed: ${res.status}`);
  const body = (await res.json()) as { Answer?: DohAnswer[] };
  return (body.Answer ?? []).filter((a) => a.type === DNS_TYPE_A).map((a) => a.data);
}
