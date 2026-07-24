// spore.host DNS naming — the "trust with infra" record scheme.
//
// A launched instance's spored registers {recordName}.{base36(accountId)}.spore.host
// with the infra DNS Lambda. The account subdomain is the AWS account number
// (12 decimal digits) rendered in base36, lowercased — a faithful port of the Go
// tool's pkg/dns/encoding.go EncodeAccountID (which uses big.Int.Text(36)).
//
// (Note: spawn's pkg/dns/encoding.go doc comment shows a wrong example value;
// the correct output matches lambda/dns-updater/main.go — see spawn#434. This
// implementation matches the actual base36 output, verified against both the
// Go Lambda and Python.)

export const SPORE_DOMAIN = "spore.host";

/** AWS account id (12 decimal digits) → lowercase base36, matching Go's EncodeAccountID. */
export function encodeAccountId(accountId: string): string {
  if (!/^\d+$/.test(accountId)) {
    throw new Error(`invalid account id: ${accountId} (must be decimal digits)`);
  }
  return BigInt(accountId).toString(36);
}

/** Full spore.host DNS name spored will register for a record in a given account. */
export function sporeHostName(recordName: string, accountId: string, domain = SPORE_DOMAIN): string {
  return `${recordName}.${encodeAccountId(accountId)}.${domain}`;
}
