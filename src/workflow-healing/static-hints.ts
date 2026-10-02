import type { Evidence, FunctionalGoal, ScreenControl } from './model.js';
import { tokensOf } from './similarity.js';

/** Un composant du code source et les contrôles de formulaire qu'il déclare. */
export interface ComponentFields {
  component: string;
  controls: readonly string[];
}

/** « CompanyInformationComponent » → company information ; « legalName » → legal name. */
function words(identifier: string): string[] {
  return tokensOf(identifier.replace(/Component$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

/**
 * STATIC EVIDENCE : le code source rapproche-t-il ce contrôle des champs de l'objectif ?
 *
 *   le nom du contrôle partage des mots avec un composant  ET  ce composant déclare des
 *   champs dont les noms partagent des mots avec les champs attendus par la suite.
 *
 * Le code SUGGÈRE (poids modéré) ; seul l'objectif vérifié au runtime confirme.
 */
export function staticLinkEvidence(
  components: readonly ComponentFields[],
  control: ScreenControl,
  goal: FunctionalGoal,
): Evidence | undefined {
  const label = new Set(tokensOf(control.name));
  if (label.size === 0) return undefined;
  const wanted = new Set(
    goal.predicates
      .filter((predicate) => predicate.kind === 'VISIBLE_FIELD')
      .flatMap((predicate) => tokensOf(predicate.value)),
  );
  if (wanted.size === 0) return undefined;
  for (const entry of components) {
    if (!words(entry.component).some((word) => label.has(word))) continue;
    const matched = entry.controls.filter((name) => words(name).some((word) => wanted.has(word)));
    if (matched.length === 0) continue;
    return {
      source: 'STATIC',
      detail: `source maps "${control.name}" to ${entry.component}, which declares ${matched.slice(0, 3).join(', ')}`,
      weight: Math.min(0.6, 0.3 + 0.1 * matched.length),
    };
  }
  return undefined;
}

/** Le graphe des dépendances de champs : une dépendance de visibilité ou d'activation observée. */
export function dependencyLinkEvidence(
  edges: readonly { from: string; to: string; kind: string }[],
  control: ScreenControl,
  goal: FunctionalGoal,
): Evidence | undefined {
  const label = new Set(tokensOf(control.name));
  const wanted = new Set(goal.predicates.flatMap((predicate) => tokensOf(predicate.value)));
  if (label.size === 0 || wanted.size === 0) return undefined;
  const edge = edges.find(
    (candidate) =>
      (candidate.kind === 'VISIBILITY_DEPENDENCY' || candidate.kind === 'ENABLEMENT_DEPENDENCY') &&
      words(candidate.from).some((word) => label.has(word)) &&
      words(candidate.to).some((word) => wanted.has(word)),
  );
  return edge
    ? { source: 'DEPENDENCY', detail: `${edge.from} → ${edge.to} (${edge.kind})`, weight: 0.3 }
    : undefined;
}
