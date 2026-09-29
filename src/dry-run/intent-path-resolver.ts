import { normalizeForMatch, tokenOverlap } from '../semantics/resolution/normalize.js';
import type { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { DryRunCandidate, DryRunDriver, KnownPath } from './dry-run-driver.js';
import type { FlowIntent } from './flow-intent-graph.js';
import type { DryRunBudgetUsage, ObservedState } from './reconciliation-model.js';

export interface DryRunBudgetLimits {
  /** Nombre d'actions au plus entre deux intentions trouvées (profondeur d'une recherche). */
  maxDepth: number;
  /** Actions exécutées au plus par l'exploration guidée, sur tout le Dry Run. */
  maxActions: number;
  maxDurationMs: number;
  /** Actions essayées au plus depuis un même écran (les mieux notées), et chemins connus rejoués au plus. */
  maxAlternativePaths: number;
  useHistoricalKnowledge: boolean;
}

/** Le budget du Dry Run : une fois épuisé, ce qui reste est NOT_VERIFIED, jamais UNREACHABLE. */
export class DryRunBudget {
  private spent = 0;
  private readonly started: number;

  constructor(
    readonly limits: DryRunBudgetLimits,
    private readonly now: () => number,
  ) {
    this.started = now();
  }

  spend(): void {
    this.spent += 1;
  }

  exhausted(): 'maxActions' | 'maxDurationMs' | undefined {
    if (this.spent >= this.limits.maxActions) return 'maxActions';
    if (this.now() - this.started >= this.limits.maxDurationMs) return 'maxDurationMs';
    return undefined;
  }

  usage(): DryRunBudgetUsage {
    const exhausted = this.exhausted();
    return {
      actions: this.spent,
      maxActions: this.limits.maxActions,
      durationMs: this.now() - this.started,
      maxDurationMs: this.limits.maxDurationMs,
      ...(exhausted ? { exhausted } : {}),
    };
  }
}

export interface PathStep {
  action: DryRunCandidate;
  from: ObservedState;
  to: ObservedState;
  formFields?: string[];
  provenance: 'OBSERVED' | 'HISTORICAL_CONFIRMED';
  reasons: string[];
}

export interface PathResolution {
  status: 'FOUND' | 'NOT_FOUND' | 'BLOCKED' | 'EXHAUSTED';
  /** L'intention atteinte, parmi celles cherchées (0 : celle attendue maintenant). */
  targetIndex?: number;
  path: PathStep[];
  confidence: number;
  source: ('historical' | 'observed')[];
  /** Autres chemins connus vers la même cible (libellés des actions). */
  alternatives: string[][];
  blocked?: { action: string; reason: string; target: string };
  /** Tout l'espace accessible dans la profondeur permise a été parcouru. */
  searchExhausted: boolean;
  reasons: string[];
}

interface Frontier {
  state: ObservedState;
  path: PathStep[];
}

/**
 * INTENT PATH RESOLVER : l'intention attendue n'est pas sur l'écran courant ; trouver
 * un chemin qui y mène, sans jamais contourner la SafetyPolicy.
 *
 * 1. Chemins connus d'abord (graphe du run, graphe mémorisé, KnowledgeBase) : la mémoire
 *    PROPOSE, l'application CONFIRME — chaque pas est rejoué sur l'écran réel, et un pas
 *    absent invalide le chemin.
 * 2. Sinon, exploration best-first : les écrans les plus proches d'abord, depuis chaque
 *    écran les `maxAlternativePaths` actions les mieux notées. Le score est celui du moteur
 *    de décision existant (ActionScorer, AdaptiveScoring), complété par ce que seul le Dry
 *    Run connaît : la proximité avec l'intention cherchée, les chemins historiques, la
 *    progression vers un résultat.
 * Les états déjà visités pour une même intention ne sont jamais revisités.
 */
export class IntentPathResolver {
  /** Actions déjà prises (état::action) et celles qui ont échoué : pénalités de répétition et d'instabilité. */
  private readonly taken = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly driver: DryRunDriver,
    private readonly budget: DryRunBudget,
    private readonly dictionary?: SemanticDictionary,
  ) {}

  async resolvePath(targets: readonly FlowIntent[]): Promise<PathResolution> {
    const start = this.driver.current();
    const alternatives: string[][] = [];
    let blocked: PathResolution['blocked'];

    // 0. Une intention suivante est déjà sur cet écran : l'attendue est dépassée (obsolète ou réordonnée).
    for (const [targetIndex, target] of targets.entries()) {
      if (targetIndex === 0) continue;
      const probe = await this.driver.probe(target);
      if (probe.status === 'RESOLVED')
        return {
          status: 'FOUND',
          targetIndex,
          path: [],
          confidence: probe.confidence,
          source: ['observed'],
          alternatives,
          searchExhausted: false,
          reasons: [`"${target.label}" (a later step) is on the current screen: ${probe.reason}`],
        };
    }

    // 1. Chemins connus : rejoués et vérifiés sur l'application réelle.
    if (this.budget.limits.useHistoricalKnowledge && this.driver.knownPaths) {
      for (const [targetIndex, target] of targets.entries()) {
        const known = this.driver
          .knownPaths(target)
          .sort((a, b) => b.observations - a.observations)
          .slice(0, this.budget.limits.maxAlternativePaths);
        for (const [rank, candidate] of known.entries()) {
          if (this.budget.exhausted()) return this.exhaustedResult(alternatives);
          const replay = await this.replay(candidate, targets);
          if (replay.blocked) blocked ??= replay.blocked;
          if (replay.found !== undefined) {
            const others = known.filter((_, index) => index !== rank).map((path) => path.actions);
            alternatives.push(...others);
            return {
              status: 'FOUND',
              targetIndex: replay.found,
              path: replay.path,
              confidence: candidate.source === 'historical' ? 0.95 : 0.92,
              source: candidate.source === 'historical' ? ['historical', 'observed'] : ['observed'],
              alternatives,
              searchExhausted: false,
              reasons: [
                `known path (${candidate.source === 'historical' ? 'historical' : 'this run'}): ${candidate.actions.join(' → ')}`,
                `${candidate.source === 'historical' ? 'historical frequency' : 'observations'}: ${String(candidate.observations)}${candidate.share !== undefined ? ` (${String(Math.round(candidate.share * 100))}% of the observed runs, not a probability)` : ''}`,
                'actual UI confirmed every step',
                ...(targetIndex > 0 ? [`reached a later intent: ${target.label}`] : []),
              ],
            };
          }
          await this.driver.restore(start.id);
        }
      }
    }

    // 2. Exploration best-first, écran par écran.
    const frontier: Frontier[] = [{ state: start, path: [] }];
    // Par identifiant d'état (empreinte) : deux écrans de même signature restent distincts pendant une recherche.
    const visited = new Set<string>([start.id]);
    while (frontier.length > 0) {
      if (this.budget.exhausted()) return this.exhaustedResult(alternatives, blocked);
      const node = frontier.shift();
      if (!node) break;
      if (node.path.length >= this.budget.limits.maxDepth) continue;
      if (this.driver.current().id !== node.state.id) {
        const back = await this.driver.restore(node.state.id);
        if (!back) continue;
      }
      const candidates = this.driver.actions();
      // Une action qui mène sans doute à la cible mais que la politique refuse : BLOCKED_BY_POLICY, pas UNREACHABLE.
      for (const candidate of candidates) {
        if (candidate.verdict !== 'BLOCK') continue;
        const best = this.bestSimilarity(candidate, targets);
        if (best.similarity >= 0.6)
          blocked ??= { action: candidate.label, reason: candidate.reason, target: best.target };
      }
      const ranked = candidates
        .filter((candidate) => candidate.verdict === 'ALLOW' && isNavigationalAction(candidate))
        .map((candidate) => ({ candidate, ...this.explorationScore(candidate, targets, node.state) }))
        .sort((a, b) => b.score - a.score || a.candidate.label.localeCompare(b.candidate.label))
        .slice(0, this.budget.limits.maxAlternativePaths);

      for (const { candidate, reasons } of ranked) {
        if (this.budget.exhausted()) return this.exhaustedResult(alternatives, blocked);
        const key = `${node.state.signature}::${candidate.signature}`;
        this.taken.add(key);
        const result = await this.driver.take(candidate.id);
        this.budget.spend();
        if (result.status !== 'SUCCESS') {
          this.failed.add(key);
          if (result.status === 'BLOCKED')
            blocked ??= {
              action: candidate.label,
              reason: result.reason ?? 'blocked',
              target: targets[0]?.label ?? '',
            };
          if (this.driver.current().id !== node.state.id) await this.driver.restore(node.state.id);
          continue;
        }
        const step: PathStep = {
          action: candidate,
          from: node.state,
          to: result.state,
          ...(result.formFields ? { formFields: result.formFields } : {}),
          provenance: 'OBSERVED',
          reasons,
        };
        if (result.state.id !== node.state.id) {
          const path = [...node.path, step];
          for (const [targetIndex, target] of targets.entries()) {
            const probe = await this.driver.probe(target);
            if (probe.status === 'RESOLVED' || probe.status === 'AMBIGUOUS')
              return {
                status: 'FOUND',
                targetIndex,
                path,
                confidence: Math.min(0.9, 0.6 + 0.3 * probe.confidence),
                source: ['observed'],
                alternatives,
                searchExhausted: false,
                reasons: [
                  `guided exploration: ${path.map((pathStep) => pathStep.action.label).join(' → ')}`,
                  `then ${target.label} found (${probe.reason})`,
                ],
              };
            if (probe.status === 'BLOCKED')
              blocked ??= {
                action: probe.target ?? target.label,
                reason: probe.reason,
                target: target.label,
              };
          }
          if (!visited.has(result.state.id)) {
            visited.add(result.state.id);
            frontier.push({ state: result.state, path });
          }
        }
        if (this.driver.current().id !== node.state.id) {
          const back = await this.driver.restore(node.state.id);
          if (!back) break;
        }
      }
    }
    await this.driver.restore(start.id);
    if (blocked)
      return {
        status: 'BLOCKED',
        path: [],
        confidence: 0.85,
        source: ['observed'],
        alternatives,
        blocked,
        searchExhausted: true,
        reasons: [`the only lead needs "${blocked.action}", refused by the safety policy: ${blocked.reason}`],
      };
    return {
      status: 'NOT_FOUND',
      path: [],
      confidence: 0.7,
      source: ['observed'],
      alternatives,
      searchExhausted: true,
      reasons: [
        `explored ${String(visited.size)} screen(s) up to ${String(this.budget.limits.maxDepth)} action(s) deep without finding it`,
      ],
    };
  }

  /**
   * explorationScore = score existant + proximité avec l'intention + chemin historique
   *   + progression vers le but + nouveauté − répétition − instabilité − risque.
   */
  explorationScore(
    candidate: DryRunCandidate,
    targets: readonly FlowIntent[],
    state: ObservedState,
  ): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;
    const add = (points: number, reason: string): void => {
      if (points === 0) return;
      score += points;
      reasons.push(`${points > 0 ? '+' : ''}${points.toFixed(2)} ${reason}`);
    };
    add(
      Math.min(1, Math.max(0, candidate.score) / 100) * 0.3,
      `existing action score ${String(candidate.score)}`,
    );
    const best = this.bestSimilarity(candidate, targets);
    add(best.similarity, `similarity with "${best.target}"`);
    if (this.driver.knownPaths && this.budget.limits.useHistoricalKnowledge) {
      const onPath = targets.some((target) =>
        (this.driver.knownPaths?.(target) ?? []).some((path) => path.actions[0] === candidate.signature),
      );
      if (onPath) add(0.6, 'first step of a known path');
    }
    const outcome = targets.some((target) => target.type === 'ASSERT' || target.type === 'SUBMIT');
    if (outcome && (candidate.category === 'submit' || candidate.category === 'form-step'))
      add(0.25, 'goal progress: completes a form toward the expected outcome');
    else if (
      candidate.category === 'navigation' ||
      candidate.category === 'menu' ||
      candidate.category === 'tab'
    )
      add(0.15, 'goal progress: navigation');
    const key = `${state.signature}::${candidate.signature}`;
    if (this.taken.has(key)) add(-0.5, 'repetition: already tried from this screen');
    else add(0.1, 'novelty');
    if (this.failed.has(key)) add(-0.3, 'instability: failed before');
    if (candidate.classification === 'MUTATION' && !outcome) add(-0.15, 'risk: changes data');
    return { score, reasons };
  }

  private bestSimilarity(
    candidate: DryRunCandidate,
    targets: readonly FlowIntent[],
  ): { similarity: number; target: string } {
    let best = { similarity: 0, target: targets[0]?.label ?? '' };
    targets.forEach((target, index) => {
      const weight = index === 0 ? 1 : 0.7;
      const similarity = weight * similarityOf(candidate, target, this.dictionary);
      if (similarity > best.similarity) best = { similarity, target: target.label };
    });
    return best;
  }

  /** Rejoue un chemin connu, pas à pas, sur l'écran réel. */
  private async replay(
    known: KnownPath,
    targets: readonly FlowIntent[],
  ): Promise<{ found?: number; path: PathStep[]; blocked?: PathResolution['blocked'] }> {
    const path: PathStep[] = [];
    for (const signature of known.actions) {
      if (this.budget.exhausted()) return { path };
      const from = this.driver.current();
      const candidate = this.driver.actions().find((action) => action.signature === signature);
      if (!candidate) return { path };
      if (candidate.verdict === 'BLOCK')
        return {
          path,
          blocked: { action: candidate.label, reason: candidate.reason, target: targets[0]?.label ?? '' },
        };
      const result = await this.driver.take(candidate.id);
      this.budget.spend();
      if (result.status !== 'SUCCESS') return { path };
      path.push({
        action: candidate,
        from,
        to: result.state,
        ...(result.formFields ? { formFields: result.formFields } : {}),
        provenance: known.source === 'historical' ? 'HISTORICAL_CONFIRMED' : 'OBSERVED',
        reasons: [`step of a known path (${known.source})`],
      });
    }
    for (const [index, target] of targets.entries()) {
      const probe = await this.driver.probe(target);
      if (probe.status === 'RESOLVED' || probe.status === 'AMBIGUOUS') return { found: index, path };
    }
    return { path };
  }

  private exhaustedResult(alternatives: string[][], blocked?: PathResolution['blocked']): PathResolution {
    return {
      status: 'EXHAUSTED',
      path: [],
      confidence: 0,
      source: ['observed'],
      alternatives,
      ...(blocked ? { blocked } : {}),
      searchExhausted: false,
      reasons: [`exploration budget exhausted (${this.budget.exhausted() ?? 'limit'})`],
    };
  }
}

/** L'exploration guidée se déplace ; elle ne remplit pas de champ isolé (les formulaires sont remplis avant leur bouton). */
function isNavigationalAction(candidate: DryRunCandidate): boolean {
  return candidate.type === 'click' || candidate.type === 'navigate';
}

/**
 * Proximité entre une action de l'écran et une intention (0..1) : mots communs,
 * concepts du dictionnaire sémantique (utilisateurs ≈ users), adresse du lien.
 */
export function similarityOf(
  candidate: Pick<DryRunCandidate, 'label' | 'href'>,
  target: Pick<FlowIntent, 'label' | 'semanticTarget'>,
  dictionary?: SemanticDictionary,
): number {
  const wanted = normalizeForMatch(target.label).tokens;
  const label = normalizeForMatch(candidate.label).tokens;
  let similarity = tokenOverlap(wanted, label).ratio;
  if (dictionary) {
    const shared = dictionary
      .conceptsIn(target.label)
      .filter((concept) => dictionary.match(concept, candidate.label) !== undefined);
    if (shared.length > 0) similarity = Math.max(similarity, 0.6);
  }
  if (candidate.href && target.semanticTarget && target.semanticTarget !== 'home') {
    const pathTokens = normalizeForMatch(candidate.href.replace(/^[a-z]+:\/\/[^/]+/i, '')).tokens;
    if (tokenOverlap(wanted, pathTokens).ratio >= 0.99) similarity = Math.max(similarity, 0.8);
  }
  return Math.round(similarity * 100) / 100;
}
