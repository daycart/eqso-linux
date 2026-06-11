---
name: WebSocket dual-server fix
description: Two WebSocketServer instances on the same httpServer using { server, path } cause upgrade handler interference — use noServer:true instead.
---

## Rule
Never use `{ server: httpServer, path: '/foo' }` for two or more `WebSocketServer` instances sharing the same Node.js `http.Server`.

**Why:** Both WSS register an `'upgrade'` event listener on the httpServer. When the second listener's `handleUpgrade` is invoked for a path that doesn't match, the ws library just returns — but this still interfers with the first WSS's socket ownership in some ws@8 edge cases, causing `"Invalid frame header"` in the browser.

**How to apply:** Use `noServer: true` for all WebSocketServers and route upgrades manually in one `httpServer.on('upgrade', ...)` handler:

```typescript
const wsBridge = startWsBridge();        // noServer: true internally
const wsRelay  = startRelayWsNotifier(); // noServer: true internally

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/ws')       wsBridge.handleUpgrade(req, socket, head, ws => wsBridge.emit('connection', ws, req));
  else if (pathname === '/ws-relay') wsRelay.handleUpgrade(req, socket, head, ws => wsRelay.emit('connection', ws, req));
  else socket.destroy();
});
```

Relevant files: `artifacts/api-server/src/index.ts`, `artifacts/api-server/src/eqso/ws-bridge.ts`, `artifacts/api-server/src/eqso/relay-ws-notifier.ts`
