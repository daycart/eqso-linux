---
name: Relay operator token injection
description: relay_operator web clients must have RELAY_TOKENS injected server-side when joining via EqsoProxy; they're already auth'd by session and can't know the token.
---

## Rule
When a relay_operator (isRelay=true) joins via EqsoProxy (remote mode) with an empty password, inject `RELAY_TOKENS.split(',')[0]` as the join password.

**Why:** The TCP server requires a relay token for callsigns starting with `0R-`. Web clients are authenticated by session (JWT), not by relay token. They shouldn't need to know the token — the server validates them at login.

**How to apply:** In `artifacts/api-server/src/eqso/ws-bridge.ts`, handleRemoteMode join case:

```typescript
const joinPassword = (isRelay && !password)
  ? (process.env.RELAY_TOKENS ?? '').split(',')[0]?.trim() ?? ''
  : password;
proxy.sendJoin(resolvedName, room, message, joinPassword);
```

This only applies when the user provides no password. Explicit passwords are always respected (e.g. connecting to a third-party server with its own token).
