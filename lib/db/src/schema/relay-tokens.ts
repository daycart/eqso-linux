import { pgTable, serial, varchar, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";

export const relayTokensTable = pgTable("relay_tokens", {
  id: serial("id").primaryKey(),
  callsign: varchar("callsign", { length: 30 }).notNull(),
  label: varchar("label", { length: 100 }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  legacyDisabled: boolean("legacy_disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [uniqueIndex("relay_tokens_hash_unique").on(table.tokenHash)]);

export type RelayToken = typeof relayTokensTable.$inferSelect;