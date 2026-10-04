import type { ScreenInventory } from './model.js';

/**
 * SCREEN INVENTORY, en texte (screen-inventory.txt) : par écran, ses éléments interactifs, le CSS
 * préféré de chacun, son nombre de correspondances, et les sélecteurs génériques NON retenus.
 * Jamais une valeur saisie : des libellés d'interface et des sélecteurs.
 */
export function screenInventoryText(inventories: readonly ScreenInventory[]): string[] {
  const lines: string[] = [];
  for (const inventory of inventories) {
    const inputs = inventory.descriptors.filter((entry) => entry.kind === 'INPUT');
    lines.push(
      'SCREEN INVENTORY',
      '----------------------------------------',
      `Screen: ${inventory.screen ?? inventory.url} (${inventory.reason}, ${String(inventory.durationMs)} ms)`,
      `Interactive elements: ${String(inventory.elements)}`,
      `Inputs: ${String(inputs.length)}`,
      '',
    );
    for (const entry of inputs) {
      lines.push(
        entry.elementId,
        `semantic: ${entry.label ?? entry.formControlName ?? '—'}`,
        `preferred CSS: ${entry.preferredCss ?? '—'}`,
        `matches: ${String(entry.preferredMatches ?? entry.structuralMatches ?? 0)}`,
        `status: ${entry.status}${entry.ambiguity && entry.ambiguity !== 'NONE' ? ` (${entry.ambiguity}: ${(entry.reasons ?? []).join(', ')})` : ''}`,
        '',
      );
    }
    // Les chemins structurels partagés par plusieurs champs : génériques, jamais retenus.
    const generic = new Map<string, number>();
    for (const entry of inputs)
      if (
        entry.structuralCss &&
        (entry.structuralMatches ?? 0) > 1 &&
        entry.preferredCss !== entry.structuralCss
      )
        generic.set(entry.structuralCss, entry.structuralMatches ?? 0);
    for (const [selector, matches] of generic)
      lines.push(
        'Generic selector:',
        selector,
        `matches: ${String(matches)}`,
        'status: AMBIGUOUS',
        'NOT SELECTED',
        '',
      );
  }
  return lines;
}

/** Résumé chiffré de l'inventaire (rapport) : écrans, éléments, éléments sans sélecteur unique. */
export function screenInventorySummary(inventories: readonly ScreenInventory[]): {
  screens: number;
  elements: number;
  unique: number;
  ambiguous: number;
} {
  const all = inventories.flatMap((inventory) => inventory.descriptors);
  return {
    screens: inventories.length,
    elements: all.length,
    unique: all.filter((entry) => entry.status === 'UNIQUE').length,
    ambiguous: all.filter((entry) => entry.status === 'AMBIGUOUS').length,
  };
}
