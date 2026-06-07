---
name: PTT Serial Context Bug
description: usePTTSerial debe ser un React Context compartido, no un hook independiente
---

**Rule:** `usePTTSerial` debe consumir un Context (`PTTSerialProvider`) compartido a nivel de App, no ser un hook con estado propio.

**Why:** Si `PTTConfigModal` y `home.tsx` llaman cada uno a `usePTTSerial()` como hook, obtienen instancias separadas del puerto serial. El modal abre el puerto al montar y lo cierra al desmontar (useEffect cleanup), dejando el `portRef` de `home.tsx` en null. El botón PTT nunca activa RTS.

**How to apply:** `PTTSerialProvider` envuelve la app en `App.tsx`. Todos los componentes consumen `usePTTSerial()` que internamente usa `useContext(PTTSerialContext)`. El puerto se abre una vez y vive toda la sesión.

**Fix implementado:** `hooks/PTTSerialProvider.tsx` (Context + auto-reconexión vía `navigator.serial.getPorts()`), `hooks/usePTTSerial.ts` (re-export del context hook), `App.tsx` (wrappeo con `<PTTSerialProvider>`).
