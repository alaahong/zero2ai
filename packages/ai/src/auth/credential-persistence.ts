/**
 * Host credential-persistence policy.
 *
 * `ZERO2AI_CREDENTIAL_STORE=broker-only` forbids persisting credentials into the
 * local SQLite store. Refresh tokens and API keys must then arrive from the auth
 * broker (`ZERO2AI_AUTH_BROKER_URL`) or the environment, so a developer-machine
 * image never carries long-lived secrets. Reads keep working — existing rows are
 * still served, which keeps a machine usable while its credentials are moved to
 * the broker.
 *
 * Set this on developer machines, NOT on the broker host: the broker is the one
 * place that legitimately stores refresh tokens.
 *
 * On Windows `chmod 0600` is a no-op, so the store's own file is additionally
 * restricted with `icacls` (no Node API exposes NTFS ACLs). Failures are logged
 * and ignored — this is defence in depth, not the primary control.
 */

export type CredentialStoreMode = "local" | "broker-only";

const DISABLE_VALUES: Readonly<Record<string, true>> = { "broker-only": true, broker: true, none: true, off: true };

/** Host-wide credential store mode; anything but the disable values means `local`. */
export function credentialStoreMode(): CredentialStoreMode {
	const raw = process.env.ZERO2AI_CREDENTIAL_STORE?.trim().toLowerCase();
	return raw && DISABLE_VALUES[raw] === true ? "broker-only" : "local";
}

/**
 * Reject a credential write when this host is configured not to persist any.
 *
 * @throws Error when `ZERO2AI_CREDENTIAL_STORE` forbids local persistence.
 */
export function assertCredentialPersistenceAllowed(provider: string): void {
	if (credentialStoreMode() === "local") return;
	throw new Error(
		`Refusing to store credentials for "${provider}" on this host: ZERO2AI_CREDENTIAL_STORE=broker-only.\n` +
			`Use the auth broker (ZERO2AI_AUTH_BROKER_URL) or supply the key via environment variable instead.`,
	);
}

const hardenedPaths = new Set<string>();

/**
 * Best-effort NTFS hardening for the credential database. No-op off Windows and
 * once per path per process; `icacls` is used because Bun/Node expose no ACL API.
 *
 * Deliberately silent, like the `chmod` it complements: this is defence in
 * depth, and a host that cannot harden an ACL must still start. Keeping this
 * module free of workspace imports also keeps it loadable on hosts without the
 * native addon.
 */
export function hardenCredentialFilePermissions(dbPath: string): void {
	if (process.platform !== "win32" || hardenedPaths.has(dbPath)) return;
	hardenedPaths.add(dbPath);
	const user = process.env.USERNAME?.trim() || process.env.USER?.trim();
	if (!user) return;
	try {
		const result = Bun.spawnSync(["icacls", dbPath, "/inheritance:r", "/grant:r", `${user}:F`], {
			stdout: "ignore",
			stderr: "ignore",
		});
		void result;
	} catch {
		// Hardening is best-effort; the credential policy above is the real control.
	}
}
