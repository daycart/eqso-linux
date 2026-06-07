/**
 * usePTTSerial — re-exporta desde PTTSerialProvider.
 *
 * El estado y la referencia al puerto viven en PTTSerialProvider (contexto
 * compartido) para que el modal de configuración y home.tsx usen la misma
 * instancia del puerto serie.
 */
export { usePTTSerial, type PTTConfig, type PTTMethod, type PTTPin } from "./PTTSerialProvider";
