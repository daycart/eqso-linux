---
name: Relay operator web authentication
description: Authenticated web operators must connect through the proxy without exposing a reusable relay credential.
---

## Rule
When an authenticated relay operator joins via the server's TCP proxy without an explicit password, provide a short-lived, single-use credential bound to that indicativo. Do not inject a shared `RELAY_TOKENS` value.

**Why:** The TCP server requires a credential for indicativos `0R-`. Operators already authenticate with a web session, but inserting the shared token would allow a revoked or migrated indicativo to bypass its individual token. Sending reusable secrets through the proxy also risks exposure in logs.

**How to apply:** The server issues the proxy credential only after verifying the operator's session; TCP consumes it once for the same indicativo. Keep explicit passwords working for third-party servers. Never log raw JOIN packets, which contain the password.
