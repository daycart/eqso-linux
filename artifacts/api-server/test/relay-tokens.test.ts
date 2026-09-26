import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { db, pool, relayTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { startTcpServer } from "../src/eqso/tcp-server";
import { roomManager } from "../src/eqso/room-manager";
import {
  authenticateRelay,
  createRelayToken,
  createWebRelayCredential,
  ensureRelayTokensTable,
  listRelayTokens,
  revokeRelayToken,
} from "../src/lib/relay-tokens";

test("1.13 password migration and revocation are isolated per callsign", async () => {
  const callsign = `0R-T${randomBytes(4).toString("hex").toUpperCase()}`;
  const other = `0R-X${randomBytes(4).toString("hex").toUpperCase()}`;
  const originalLegacy = process.env.RELAY_TOKENS;
  process.env.RELAY_TOKENS = "test-legacy-shared";
  try {
    await ensureRelayTokensTable();
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, true);
    const { row, token } = await createRelayToken(callsign, "Prueba de migración");
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, true);
    assert.equal((await authenticateRelay(other, token)).allowed, false);
    assert.equal((await authenticateRelay(callsign, token)).tokenId, row.id);
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, false);
    assert.equal((await authenticateRelay(other, "test-legacy-shared")).allowed, true);
    const listed = (await listRelayTokens()).find((entry) => entry.id === row.id);
    assert.equal(listed?.legacyDisabled, true);
    assert.ok(listed?.lastUsedAt);
    assert.equal("token" in (listed ?? {}), false);
    // If a JOIN is in flight while an admin revokes the credential, it
    // cannot finish authenticating with that revoked token.
    const pendingJoin = authenticateRelay(callsign, token);
    const pendingRevocation = revokeRelayToken(row.id);
    await pendingRevocation;
    assert.equal((await pendingJoin).allowed, false);
    assert.equal((await authenticateRelay(callsign, token)).allowed, false);
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, false);
    const webCredential = createWebRelayCredential(callsign);
    assert.equal((await authenticateRelay(other, webCredential)).allowed, false);
    assert.equal((await authenticateRelay(callsign, webCredential)).allowed, false);
    const webCredential2 = createWebRelayCredential(callsign);
    assert.equal((await authenticateRelay(callsign, webCredential2)).allowed, true);
    assert.equal((await authenticateRelay(callsign, webCredential2)).allowed, false);

    const second = await createRelayToken(callsign, "Prueba de desconexión TCP");
    const server = startTcpServer(0);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const socket = net.createConnection({ port: address.port, host: "127.0.0.1" });
    socket.on("data", () => { /* consume handshake, member list and keepalives */ });
    try {
      await once(socket, "connect");
      const fields = [callsign.toLowerCase(), "CB", "test", second.token].map((value) => Buffer.from(value, "ascii"));
      socket.write(Buffer.concat([
        Buffer.from([0x0a, 0x78, 0, 0, 0, 0x1a]),
        ...fields.flatMap((field) => [Buffer.from([field.length]), field]),
      ]));
      const deadline = Date.now() + 3000;
      while (!roomManager.getAllClients().some((client) => client.name === callsign && client.room === "CB")) {
        assert.ok(Date.now() < deadline, "v1.13 JOIN should authenticate with the new token");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const closed = once(socket, "close");
      await revokeRelayToken(second.row.id);
      // API route uses the same function after the DB update.
      const { disconnectManagedRelayToken } = await import("../src/eqso/tcp-server");
      disconnectManagedRelayToken(second.row.id);
      await closed;
      assert.equal(roomManager.getAllClients().some((client) => client.name === callsign), false);
    } finally {
      socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await db.delete(relayTokensTable).where(eq(relayTokensTable.callsign, callsign));
    if (originalLegacy === undefined) delete process.env.RELAY_TOKENS;
    else process.env.RELAY_TOKENS = originalLegacy;
    await pool.end();
  }
});