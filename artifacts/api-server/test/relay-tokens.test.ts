import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { db, pool, relayTokensTable, serversTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
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
  const serverOnlyCallsign = `0R-S${randomBytes(4).toString("hex").toUpperCase()}`;
  const localPassword = "test-local-server-password";
  const originalLegacy = process.env.RELAY_TOKENS;
  const originalServer = process.env.EQSO_PASSWORD;
  let localServerId: number | undefined;
  let localTokenId: number | undefined;
  process.env.RELAY_TOKENS = "test-legacy-shared";
  process.env.EQSO_PASSWORD = "test-server-password";
  try {
    await ensureRelayTokensTable();
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, true);
    assert.equal((await authenticateRelay(callsign, "test-server-password")).allowed, true);
    const { row, token } = await createRelayToken(callsign, "Prueba de migración");
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, true);
    assert.equal((await authenticateRelay(callsign, "test-server-password")).allowed, true);
    assert.equal((await authenticateRelay(other, token)).allowed, false);
    assert.equal((await authenticateRelay(callsign, token)).tokenId, row.id);
    assert.equal((await authenticateRelay(callsign, "test-legacy-shared")).allowed, false);
    assert.equal((await authenticateRelay(callsign, "test-server-password")).allowed, false);
    assert.equal((await authenticateRelay(other, "test-legacy-shared")).allowed, true);
    assert.equal((await authenticateRelay(other, "test-server-password")).allowed, true);
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

    // The production-like case: eQSO 1.13 uses only EQSO_PASSWORD, with no
    // RELAY_TOKENS configured. Creating a token must not disconnect it.
    delete process.env.RELAY_TOKENS;
    assert.equal((await authenticateRelay(serverOnlyCallsign, "test-server-password")).allowed, true);
    const serverOnlyToken = await createRelayToken(serverOnlyCallsign, "Servidor 1.13");
    assert.equal((await authenticateRelay(serverOnlyCallsign, "test-server-password")).allowed, true);
    const second = await createRelayToken(callsign, "Prueba de desconexión TCP");
    const server = startTcpServer(0);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connect = async (name: string, password: string) => {
      const client = net.createConnection({ port: address.port, host: "127.0.0.1" });
      client.on("data", () => { /* consume handshake, member list and keepalives */ });
      await once(client, "connect");
      const fields = [name.toLowerCase(), "CB", "test", password].map((value) => Buffer.from(value, "ascii"));
      client.write(Buffer.concat([
        Buffer.from([0x0a, 0x78, 0, 0, 0, 0x1a]),
        ...fields.flatMap((field) => [Buffer.from([field.length]), field]),
      ]));
      const deadline = Date.now() + 3000;
      while (!roomManager.getAllClients().some((member) => member.name === name && member.room === "CB")) {
        assert.ok(Date.now() < deadline, "v1.13 JOIN should authenticate");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return client;
    };
    let socket: net.Socket | undefined;
    let legacySocket: net.Socket | undefined;
    let localSocket: net.Socket | undefined;
    try {
      legacySocket = await connect(serverOnlyCallsign, "test-server-password");
      const legacyClosed = once(legacySocket, "close");
      legacySocket.destroy();
      await legacyClosed;
      assert.equal((await authenticateRelay(serverOnlyCallsign, serverOnlyToken.token)).allowed, true);
      assert.equal((await authenticateRelay(serverOnlyCallsign, "test-server-password")).allowed, false);
      await revokeRelayToken(serverOnlyToken.row.id);
      assert.equal((await authenticateRelay(serverOnlyCallsign, "test-server-password")).allowed, false);

      socket = await connect(callsign, second.token);
      const closed = once(socket, "close");
      await revokeRelayToken(second.row.id);
      // API route uses the same function after the DB update.
      const { disconnectManagedRelayToken } = await import("../src/eqso/tcp-server");
      disconnectManagedRelayToken(second.row.id);
      await closed;
      assert.equal(roomManager.getAllClients().some((client) => client.name === callsign), false);

      // The named local server's password is accepted only for the five
      // allowlisted 1.13 callsigns and only before their first managed JOIN.
      delete process.env.EQSO_PASSWORD;
      const [fixture] = await db.update(serversTable).set({ defaultPassword: localPassword })
        .where(and(
          eq(serversTable.label, "Servidor Local"),
          eq(serversTable.mode, "local"),
          isNull(serversTable.defaultPassword),
        )).returning({ id: serversTable.id });
      assert.ok(fixture, "development Servidor Local must have no configured password");
      localServerId = fixture.id;
      for (const allowed of ["0R-JN12LG", "0R-IN5200", "0R-IN53SI", "0R-JN11BK", "0R-IN70WN"]) {
        assert.equal((await authenticateRelay(allowed, localPassword)).allowed, true, allowed);
      }
      assert.equal((await authenticateRelay("0R-UNLISTED", localPassword)).allowed, false);
      const localToken = await createRelayToken("0R-JN12LG", "Prueba de contraseña local");
      localTokenId = localToken.row.id;
      localSocket = await connect("0R-JN12LG", localPassword);
      const localClosed = once(localSocket, "close");
      localSocket.destroy();
      await localClosed;
      assert.equal((await authenticateRelay("0R-JN12LG", localPassword)).allowed, true);
      assert.equal((await authenticateRelay("0R-JN12LG", localToken.token)).allowed, true);
      assert.equal((await authenticateRelay("0R-JN12LG", localPassword)).allowed, false);
      await revokeRelayToken(localToken.row.id);
      assert.equal((await authenticateRelay("0R-JN12LG", localPassword)).allowed, false);
    } finally {
      socket?.destroy();
      legacySocket?.destroy();
      localSocket?.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    if (localServerId !== undefined) {
      await db.update(serversTable).set({ defaultPassword: null })
        .where(and(eq(serversTable.id, localServerId), eq(serversTable.defaultPassword, localPassword)));
    }
    if (localTokenId !== undefined) {
      await db.delete(relayTokensTable).where(eq(relayTokensTable.id, localTokenId));
    }
    await db.delete(relayTokensTable).where(eq(relayTokensTable.callsign, callsign));
    await db.delete(relayTokensTable).where(eq(relayTokensTable.callsign, serverOnlyCallsign));
    if (originalLegacy === undefined) delete process.env.RELAY_TOKENS;
    else process.env.RELAY_TOKENS = originalLegacy;
    if (originalServer === undefined) delete process.env.EQSO_PASSWORD;
    else process.env.EQSO_PASSWORD = originalServer;
    await pool.end();
  }
});