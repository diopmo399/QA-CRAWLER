import type { CartographyModel, Feature, MapDecision } from '../sdk/core/cartography.js';
import { applyApiDecisions } from './apis.js';

/**
 * LES DÉCISIONS D'UNE PERSONNE, rejouées sur chaque scan dans l'ordre où elles ont été prises : confirmer,
 * renommer, fusionner, rejeter, restaurer une fonctionnalité ; valider un concept. Une décision sur un
 * élément qui n'existe plus est gardée (historique) mais sans effet. Le scan ne les écrase jamais.
 */
export function applyDecisions(model: CartographyModel, decisions: readonly MapDecision[]): CartographyModel {
  const features = new Map<string, Feature>(
    model.features.map((feature) => [feature.id, structuredClone(feature)]),
  );
  const concepts = model.concepts.map((concept) => structuredClone(concept));
  for (const decision of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    if (decision.kind === 'VALIDATE_CONCEPT') {
      const concept = concepts.find((entry) => entry.id === decision.target);
      if (concept) concept.status = 'VALIDATED';
      continue;
    }
    const feature = features.get(decision.target);
    if (!feature) continue;
    switch (decision.kind) {
      case 'CONFIRM':
        feature.status = 'CONFIRMED';
        break;
      case 'REJECT':
        feature.status = 'REJECTED';
        break;
      case 'RESTORE':
        feature.status = 'CANDIDATE';
        feature.name = feature.proposedName;
        break;
      case 'RENAME':
        if (decision.value?.trim()) feature.name = decision.value.trim();
        break;
      case 'MERGE': {
        // La fonctionnalité `value` est absorbée dans `target` : ses nœuds, champs et étapes la rejoignent.
        const other = decision.value ? features.get(decision.value) : undefined;
        if (!other || other.id === feature.id) break;
        feature.nodes = [...new Set([...feature.nodes, ...other.nodes])];
        feature.fields = [...new Set([...feature.fields, ...other.fields])];
        feature.layers = [...new Set([...feature.layers, ...other.layers])];
        feature.chain = [
          ...feature.chain,
          ...other.chain.filter(
            (step) => !feature.chain.some((s) => s.node === step.node && step.node !== ''),
          ),
        ];
        feature.evidence = [...feature.evidence, ...other.evidence];
        feature.reach = { ...other.reach, ...feature.reach };
        feature.mergedFrom = [...(feature.mergedFrom ?? []), other.id];
        features.delete(other.id);
        for (const concept of concepts)
          concept.features = [...new Set(concept.features.map((id) => (id === other.id ? feature.id : id)))];
        break;
      }
      default:
        break;
    }
  }
  return {
    ...model,
    features: [...features.values()],
    concepts,
    ...(model.apis ? { apis: applyApiDecisions(model.apis, decisions) } : {}),
  };
}
