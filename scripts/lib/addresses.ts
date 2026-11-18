// The e-mail addresses used against the real test API come from .env and
// must be ones the operator controls: the provider may send real mail to
// them. This file checks them and says what is wrong without printing one.

/** Why an address cannot be used, or '' when it can. Never returns the address itself. */
function flaw(address: string): string {
  if (/seu-dominio|your-domain/i.test(address)) return 'is still the placeholder from the instructions';
  if (/example\./i.test(address)) return 'is an example.com address, which nobody reads';
  if (!address.includes('@')) return 'has no @';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return 'is not shaped like an e-mail address';
  return '';
}

export interface Addresses {
  client: string;
  /** Always three, all different from each other and from the client. */
  team: string[];
  /** What was given and what was made up from it, in words, with no address in it. */
  note: string;
}

/**
 * One client address and three payee addresses. Someone with only one or
 * two mailboxes gives what they have: the missing payees become "+tag"
 * aliases of an address already given (a Gmail one when there is one).
 * Gmail and Outlook deliver those to the same mailbox, so every message the
 * provider sends still reaches the operator.
 */
export function addresses(): Addresses {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const client = (process.env.DEMO_CLIENT_EMAIL ?? '').trim();
  const listed = (process.env.DEMO_TEAM_EMAILS ?? '')
    .split(/[,;\s]+/)
    .map((address) => address.trim())
    .filter(Boolean);
  const problems = [
    process.env.DEMO_CLIENT_EMAIL === undefined ? 'DEMO_CLIENT_EMAIL is not set' : '',
    process.env.DEMO_CLIENT_EMAIL !== undefined && flaw(client) ? `DEMO_CLIENT_EMAIL ${flaw(client)}` : '',
    listed.length > 3 ? `DEMO_TEAM_EMAILS has ${listed.length} addresses, it takes at most 3` : '',
    ...listed.map((address, i) => (flaw(address) ? `address ${i + 1} of DEMO_TEAM_EMAILS ${flaw(address)}` : '')),
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`.env: ${problems.join('; ')}`);

  // A payee cannot be the client, and nobody appears twice.
  const given = listed.filter(
    (address, i) => !same(address, client) && listed.findIndex((x) => same(x, address)) === i,
  );
  const base = [...given, client].find((address) => /@(gmail|googlemail)\.com$/i.test(address)) ?? given[0] ?? client;
  const [local = '', domain = ''] = base.split('@');
  const team = [...given];
  for (let n = 1; team.length < 3; n++) {
    const alias = `${local.split('+')[0]}+payee${n}@${domain}`;
    if (!same(alias, client) && !team.some((address) => same(address, alias))) team.push(alias);
  }
  const made = 3 - given.length;
  const note =
    made === 0
      ? 'client: 1 address; payees: 3 addresses given'
      : `client: 1 address; payees: ${given.length} given, ${made} made as "+payee" aliases of an address already given`;
  return { client, team, note };
}
