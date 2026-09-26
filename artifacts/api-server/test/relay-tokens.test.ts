import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { db, pool, relayTokensTable, serversTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { startTcpServer } from "../src/eqso/tcp-server";
import { EqsoProxy } from "../src/eqso/eqso-proxy";
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
  const localPassword = process.env.EQSO_TEST_LOG_MARKER ?? "test-local-server-password";
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
    const sendJoin = async (name: string, password: string) => {
      const client = net.createConnection({ port: address.port, host: "127.0.0.1" });
      client.on("data", () => { /* consume handshake, member list and keepalives */ });
      await once(client, "connect");
      const fields = [name.toLowerCase(), "CB", "test", password].map((value) => Buffer.from(value, "ascii"));
      client.write(Buffer.concat([
        Buffer.from([0x0a, 0x78, 0, 0, 0, 0x1a]),
        ...fields.flatMap((field) => [Buffer.from([field.length]), field]),
      ]));
      return client;
    };
    const connect = async (name: string, password: string) => {
      const client = await sendJoin(name, password);
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
    let rejectedSocket: net.Socket | undefined;
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
      rejectedSocket = await sendJoin("0R-UNLISTED", localPassword);
      await once(rejectedSocket, "close");
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
      rejectedSocket?.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    // A remote server may echo a credential in text, a room name, or a user
    // update message. The proxy must forward these events without logging
    // their untrusted content.
    const remoteServer = net.createServer();
    await new Promise<void>((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
    const remoteAddress = remoteServer.address();
    assert.ok(remoteAddress && typeof remoteAddress !== "string");
    let remoteSocket: net.Socket | undefined;
    remoteServer.on("connection", (peer) => {
      remoteSocket = peer;
      peer.once("data", () => {
        const marker = Buffer.from(localPassword, "ascii");
        const name = Buffer.from("REMOTE", "ascii");
        const userJoined = Buffer.concat([
          Buffer.from([0x16, 1, 0, 0, 0, 0, 0, 0, 0, name.length]), name,
          Buffer.from([marker.length]), marker, Buffer.from([0]),
        ]);
        peer.write(Buffer.concat([
          Buffer.from([0x0a, 0x82, 0, 0, 0]),
          Buffer.from([0x0b, marker.length]), marker, Buffer.from([0x03]),
          Buffer.from([0x14, 1, 0, 0, 0, marker.length]), marker,
          userJoined,
        ]));
      });
    });
    const proxy = new EqsoProxy("127.0.0.1", remoteAddress.port);
    try {
      const received = new Set<string>();
      const completed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("proxy echo fixture timed out")), 3000);
        proxy.on("event", (event: { type: string }) => {
          received.add(event.type);
          if (["connected", "server_info", "room_list", "user_joined"].every((type) => received.has(type))) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      proxy.connect();
      await completed;
    } finally {
      proxy.disconnect();
      remoteSocket?.destroy();
      await new Promise<void>((resolve, reject) => remoteServer.close((error) => error ? reject(error) : resolve()));
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