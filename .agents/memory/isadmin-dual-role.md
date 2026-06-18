---
name: isAdmin dual-role logic
description: Lógica para usuarios con rol relay_operator que también son admin global (isAdmin=true).
---

## Regla de negocio

- `relay_operator` sin `isAdmin` → va directo al panel relay al login (confinado)
- `relay_operator` con `isAdmin=true` → va al panel principal con botones Admin + Mi Relay
- `admin` puro → panel principal con botón Admin

## Implementación

`handleAuth` en `home.tsx`:
```javascript
setShowRelayPanel((session.role === "relay_operator" || !!session.isRelay) && !session.isAdmin);
```

Render order en `home.tsx`:
1. `!auth` → login
2. `showAdmin` → AdminPanel
3. `showRelayPanel && auth.isAdmin` → RelayOperatorPanel no confinado
4. `auth.role === "relay_operator" && !auth.isAdmin` → RelayOperatorPanel confinado
5. → UI principal

## Para activar en un usuario en la VM

```sql
UPDATE users SET is_admin = true WHERE callsign = 'INDICATIVO';
```

Luego rebuild cliente + servidor + restart (ver vm-deploy-build-order.md).

**Why:** El campo `is_admin` en la BD controla si un relay_operator puede acceder también al panel de admin. `effectiveIsAdmin = user.isAdmin || role === "admin"` en auth.ts.
