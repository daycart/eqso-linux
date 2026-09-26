import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, pool, relayTokensTable } from "@workspace/db";

// Idempotent, additive migration; never push the entire schema against the VM.
let tableReady: Promise<void> | undefined;
const revokingTokenIds = new Set<number>();
export const isRelayTokenRevoking = (id: number): boolean => revokingTokenIds.has(id);
export function ensureRelayTokensTable(): Promise<void> {
  tableReady ??= pool.query(`
    CREATE TABLE IF NOT EXISTS relay_tokens (
      id serial PRIMARY KEY,
      callsign varchar(30) NOT NULL,
      label varchar(100) NOT NULL,
      token_hash varchar(64) NOT NULL UNIQUE,
      legacy_disabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz,
      revoked_at timestamptz
    )
  `).then(() => undefined).catch((error: unknown) => {
    tableReady = undefined;
    throw error;
  });
  return tableReady;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const webCredentials = new Map<string, { callsign: string; expiresAt: number }>();

// The browser authenticates with its session; its server-side TCP proxy gets a
// short-lived, single-use credential rather than a shared RELAY_TOKENS value.
export function createWebRelayCredential(callsign: string): string {
  const now = Date.now();
  for (const [hash, entry] of webCredentials) {
    if (entry.expiresAt < now) webCredentials.delete(hash);
  }
  const credential = `eqso_web_${randomBytes(24).toString("base64url")}`;
  webCredentials.set(digest(credential), { callsign, expiresAt: now + 60_000 });
  return credential;
}

function consumeWebRelayCredential(callsign: string, password: string): boolean {
  const hash = digest(password);
  const entry = webCredentials.get(hash);
  if (!entry) return false;
  webCredentials.delete(hash);
  return entry.callsign === callsign && entry.expiresAt >= Date.now();
}

function legacyMatches(password: string): boolean {
  const candidate = Buffer.from(digest(password), "hex");
  return (process.env.RELAY_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean)
    .some((token) => timingSafeEqual(candidate, Buffer.from(digest(token), "hex")));
}

export type RelayAuthentication = { allowed: boolean; tokenId?: number; tokenRequired: boolean };

export async function authenticateRelay(callsign: string, password: string): Promise<RelayAuthentication> {
  if (consumeWebRelayCredential(callsign, password)) return { allowed: true, tokenRequired: true };
  await ensureRelayTokensTable();
  const rows = await db.select({
    id: relayTokensTable.id,
    tokenHash: relayTokensTable.tokenHash,
    revokedAt: relayTokensTable.revokedAt,
    legacyDisabled: relayTokensTable.legacyDisabled,
  }).from(relayTokensTable).where(eq(relayTokensTable.callsign, callsign));

  const match = rows.find((row) => row.revokedAt === null &&
    timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(digest(password), "hex")));
  if (match) {
    if (revokingTokenIds.has(match.id)) return { allowed: false, tokenRequired: true };
    const [stillActive] = await db.update(relayTokensTable).set({ lastUsedAt: new Date() })
      .where(and(eq(relayTokensTable.id, match.id), isNull(relayTokensTable.revokedAt)))
      .returning({ id: relayTokensTable.id });
    if (!stillActive || revokingTokenIds.has(match.id)) return { allowed: false, tokenRequired: true };
    // The first successful managed JOIN switches only this callsign away from
    // shared credentials. Keep the migration marker even after revocation.
    await db.update(relayTokensTable).set({ legacyDisabled: true })
      .where(eq(relayTokensTable.callsign, callsign));
    if (revokingTokenIds.has(match.id)) return { allowed: false, tokenRequired: true };
    return { allowed: true, tokenId: match.id, tokenRequired: true };
  }

  const legacyConfigured = (process.env.RELAY_TOKENS ?? "").split(",").some((t) => t.trim());
  const migrated = rows.some((row) => row.legacyDisabled);
  if (!migrated && legacyConfigured && legacyMatches(password)) {
    return { allowed: true, tokenRequired: true };
  }
  if (legacyConfigured || rows.length > 0) {
    return { allowed: false, tokenRequired: true };
  }
  // Preserve the original EQSO_PASSWORD behavior until a relay token exists.
  const serverPassword = process.env.EQSO_PASSWORD ?? "";
  return { allowed: !serverPassword || password === serverPassword, tokenRequired: false };
}

export async function createRelayToken(callsign: string, label: string) {
  await ensureRelayTokensTable();
  const token = `eqso_${randomBytes(24).toString("base64url")}`;
  const [row] = await db.insert(relayTokensTable).values({
    callsign, label, tokenHash: digest(token),
  }).returning();
  return { row, token };
}

export async function listRelayTokens() {
  await ensureRelayTokensTable();
  const rows = await db.select({
    id: relayTokensTable.id,
    callsign: relayTokensTable.callsign,
    label: relayTokensTable.label,
    legacyDisabled: relayTokensTable.legacyDisabled,
    createdAt: relayTokensTable.createdAt,
    lastUsedAt: relayTokensTable.lastUsedAt,
    revokedAt: relayTokensTable.revokedAt,
  }).from(relayTokensTable).orderBy(relayTokensTable.id);
  const migrated = new Set(rows.filter((row) => row.legacyDisabled).map((row) => row.callsign));
  return rows.map((row) => ({ ...row, legacyDisabled: migrated.has(row.callsign) }));
}

export async function revokeRelayToken(id: number) {
  revokingTokenIds.add(id);
  try {
    await ensureRelayTokensTable();
    const [row] = await db.update(relayTokensTable).set({ revokedAt: new Date() })
      .where(and(eq(relayTokensTable.id, id), isNull(relayTokensTable.revokedAt)))
      .returning({ id: relayTokensTable.id, callsign: relayTokensTable.callsign });
    if (!row) revokingTokenIds.delete(id);
    return row;
  } catch (error) {
    revokingTokenIds.delete(id);
    throw error;
  }
}