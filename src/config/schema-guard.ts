import { z, type ZodTypeAny } from 'zod';

/**
 * Chemins des z.enum(CONSTANTE) qui n'ont reçu aucune valeur. Une constante absente
 * (fichier local pas à jour, export renommé, import circulaire) donne un enum sans
 * valeurs : zod plante alors en construisant son message (« Cannot read properties of
 * undefined (reading 'map') ») au lieu de dire quelle valeur il refuse.
 */
export function brokenEnums(schema: ZodTypeAny, path = '', seen = new Set<ZodTypeAny>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const walk = (child: ZodTypeAny | undefined, suffix: string): string[] =>
    child ? brokenEnums(child, `${path}${suffix}`, seen) : [];
  if (schema instanceof z.ZodEnum) {
    const values = (schema._def as { values?: unknown }).values;
    return Array.isArray(values) && values.length > 0 ? [] : [path || '(root)'];
  }
  if (schema instanceof z.ZodObject)
    return Object.entries(schema.shape as Record<string, ZodTypeAny>).flatMap(([key, child]) =>
      walk(child, path ? `.${key}` : key),
    );
  if (schema instanceof z.ZodDefault || schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return walk(schema._def.innerType as ZodTypeAny, '');
  if (schema instanceof z.ZodArray) return walk(schema.element as ZodTypeAny, '[]');
  if (schema instanceof z.ZodRecord)
    return [
      ...walk(schema.keySchema as ZodTypeAny, '{key}'),
      ...walk(schema.valueSchema as ZodTypeAny, '{}'),
    ];
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion)
    return (schema.options as ZodTypeAny[]).flatMap((option, index) => walk(option, `|${index}`));
  if (schema instanceof z.ZodEffects) return walk(schema.innerType() as ZodTypeAny, '');
  if (schema instanceof z.ZodIntersection)
    return [...walk(schema._def.left as ZodTypeAny, '&L'), ...walk(schema._def.right as ZodTypeAny, '&R')];
  if (schema instanceof z.ZodLazy) return walk(schema.schema as ZodTypeAny, '');
  return [];
}
