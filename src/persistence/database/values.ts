/** Conversions des valeurs lues, communes aux adaptateurs. */

/** Date lue (Date, texte ISO ou texte du moteur) → ISO 8601 UTC avec millisecondes. */
export function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(textOf(value));
  if (Number.isNaN(date.getTime())) throw new Error(`not a timestamp: ${textOf(value)}`);
  return date.toISOString();
}

/** JSON lu (objet déjà décodé par le pilote, ou texte) → objet. */
export function jsonOf(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  const parsed = JSON.parse(textOf(value)) as unknown;
  return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** Valeur scalaire lue → texte (jamais « [object Object] »). */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw new Error(`unexpected database value: ${typeof value}`);
}

/** NULL SQL (null ou undefined selon le pilote). */
export function isNull(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}
