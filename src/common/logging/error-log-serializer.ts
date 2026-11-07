// Reexporta el serializador defensivo ya implementado y probado (Grupo M,
// T-M03/T-M04) en src/shared/money/bigint-serializer.ts — es exactamente
// el comportamiento que TASK-auth.md pide para `metadata` de ErrorLog
// ("cualquier valor no convertible a JSON se reemplaza por un string
// legible"). Duplicarlo aquí arriesgaría que las dos copias diverjan.
export { sanitizeMetadata } from '../../shared/money/bigint-serializer';
