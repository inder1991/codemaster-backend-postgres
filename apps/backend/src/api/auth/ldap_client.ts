// LDAP client port — production wraps an LDAP library (TLS mandatory; service-account creds from Vault;
// username RFC-4515-escaped before any search filter). Current deployment injects NoOpLdapClient.

/** Raised on bind failure (bad credentials OR LDAP unreachable). */
export class LdapBindError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LdapBindError";
  }
}

/** Plain ldap:// without StartTLS — refused at startup. */
export class LdapInsecureConnectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LdapInsecureConnectionError";
  }
}

export type AuthenticatedUser = {
  user_id: string;
  email: string;
  full_name: string;
  groups: ReadonlyArray<string>;
};

export type LdapClientPort = {
  authenticate(args: { username: string; password: string }): Promise<AuthenticatedUser>;
};

// RFC 4515 LDAP search-filter escape table.
const LDAP_ESCAPE_RE = /[*()\\\0]/g;
const LDAP_ESCAPE_MAP = new Map<string, string>([
  ["*", "\\2a"],
  ["(", "\\28"],
  [")", "\\29"],
  ["\\", "\\5c"],
  ["\0", "\\00"],
]);

/** Escape user-supplied input for an LDAP search filter (RFC 4515). */
export function escapeLdapFilter(value: string): string {
  return value.replace(LDAP_ESCAPE_RE, (m) => LDAP_ESCAPE_MAP.get(m) ?? m);
}
