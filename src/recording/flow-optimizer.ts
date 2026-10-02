import type { RecordedState, SemanticRecordedAction } from './model.js';
import { controlKey, isWrite, protectedAction } from './normalizer.js';

export interface OptimizationResult {
  /** Les actions du flow raccourci (copies : le parcours humain n'est jamais modifié). */
  kept: SemanticRecordedAction[];
  /** Ce que l'optimiseur propose de retirer, et pourquoi. */
  removed: { actionId: string; label: string; reason: string }[];
}

/**
 * FLOW OPTIMIZER — séparé, facultatif, désactivé par défaut. La normalisation répond « comment
 * représenter proprement ce que l'humain a fait ? » ; l'optimisation « certaines étapes
 * pourraient-elles être retirées ? ». Son résultat est un AUTRE flow (optimized.flow.yaml) :
 * generated.flow.yaml reste le parcours enseigné par l'humain.
 *
 * Règle : un détour (un onglet / lien ouvert puis quitté aussitôt pour un contrôle déjà
 * visible avant lui). Jamais une action qui écrit, porte un point de contrôle, change
 * l'écran ou dont une action suivante dépend.
 */
export function optimizeRecordedActions(
  kept: readonly SemanticRecordedAction[],
  states: readonly RecordedState[],
  preserve: ReadonlySet<string> = new Set(),
): OptimizationResult {
  const stateById = new Map(states.map((state) => [state.id, state]));
  const actions = kept.map((action) => ({ ...action }));
  const removed: OptimizationResult['removed'] = [];
  const out = new Set<string>();
  for (const [index, action] of actions.entries()) {
    const next = actions[index + 1];
    if (!next || !isNavigationClick(action) || protectedAction(action) || preserve.has(action.id)) continue;
    const before = action.stateBefore ? stateById.get(action.stateBefore) : undefined;
    if (!before) continue;
    const backToStart = next.type === 'NAVIGATE' && next.route === before.route;
    const reachableBefore =
      next.type !== 'NAVIGATE' && next.target !== undefined && before.controls.includes(controlKey(next));
    if (backToStart) {
      out.add(action.id).add(next.id);
      removed.push(
        {
          actionId: action.id,
          label: action.target?.label ?? action.type,
          reason: 'detour: left immediately, back to the previous page',
        },
        { actionId: next.id, label: next.route ?? 'navigation', reason: 'detour: back to the previous page' },
      );
    } else if (reachableBefore) {
      out.add(action.id);
      removed.push({
        actionId: action.id,
        label: action.target?.label ?? action.type,
        reason: `detour: "${next.target?.label ?? ''}" was already reachable before`,
      });
    }
  }
  return { kept: actions.filter((action) => !out.has(action.id)), removed };
}

function isNavigationClick(action: SemanticRecordedAction): boolean {
  if (action.type !== 'CLICK' || !action.target) return false;
  const target = action.target.target;
  const role = target.strategy === 'role' ? target.role : undefined;
  const reads = action.network.every((exchange) => !isWrite(exchange.method));
  return reads && (role === 'link' || role === 'tab' || role === 'menuitem');
}
