import { actionLabel, type DiscoveredAction } from '../../model/discovered-action.js';
import type { PageContext } from '../../model/page-context.js';
import type { SemanticDictionary } from '../semantic-dictionary.js';
import { actionTargetSignature, nameComponents, restAfterConcepts } from './action-resolver.js';
import type { NavigateIntent } from './intent.js';
import { describeIntent } from './intent.js';
import { containsPhrase, matchKey, normalizeForMatch } from './normalize.js';
import {
  candidateOf,
  decide,
  levelOf,
  rank,
  renderComponent,
  type ResolutionCandidate,
  type ResolutionStatus,
  type ResolutionThresholds,
  type ScoreComponent,
} from './resolution.js';
import { MAX_HISTORY_POINTS, type SemanticHistory } from './semantic-history.js';

export interface NavigationResolution {
  status: ResolutionStatus;
  intent: string;
  intentKey: string;
  /** Déjà sur la page demandée : rien à cliquer. */
  alreadyThere?: string;
  selected?: DiscoveredAction;
  score: number;
  confidence: string;
  candidates: ResolutionCandidate[];
  reasons: string[];
  targetSignature?: string;
}

const NAVIGABLE = new Set(['navigation', 'tab', 'menu', 'details']);

/**
 * NAVIGATION RESOLVER : « j'ouvre les utilisateurs », « je vais dans les paramètres »,
 * « j'accède à la gestion des rôles ». Liens, boutons, onglets, entrées de menu —
 * libellé, synonymes du dictionnaire (utilisateurs ≈ users, paramètres ≈ settings),
 * adresse du lien. Déjà sur la page ? Rien à faire.
 */
export class NavigationResolver {
  constructor(
    private readonly dictionary: SemanticDictionary,
    private readonly thresholds: ResolutionThresholds,
  ) {}

  resolve(
    intent: NavigateIntent,
    context: PageContext,
    options: { stateSignature: string; history?: SemanticHistory },
  ): NavigationResolution {
    const intentKey = `navigate:${matchKey(intent.target)}`;
    const common = { intent: describeIntent(intent), intentKey };
    const here = this.currentPage(intent.target, context);
    if (here)
      return {
        ...common,
        status: 'RESOLVED',
        alreadyThere: here,
        score: 1,
        confidence: levelOf(1),
        candidates: [],
        reasons: [`already on "${here}"`],
      };
    const wanted = normalizeForMatch(intent.target).tokens;
    const wantedConcepts = new Set(this.dictionary.conceptsIn(intent.target));
    const scored = context.actions
      .filter(
        (action) =>
          (action.type === 'navigate' || action.type === 'click') &&
          action.visible &&
          !action.disabled &&
          !action.obscured &&
          !action.external,
      )
      .map((action) => {
        const components: ScoreComponent[] = [];
        const label = actionLabel(action);
        nameComponents(components, wanted, label, intent.target);
        if (
          !components.some((component) => component.points >= 70) &&
          this.dictionary.mentions(intent.target, label)
        )
          components.push({
            factor: 'alias',
            points: 50,
            detail: `"${label}" names "${intent.target}" (synonym, plural)`,
          });
        const shared = this.dictionary.conceptsIn(label).filter((concept) => wantedConcepts.has(concept));
        const pure = restAfterConcepts(this.dictionary, shared, wanted).length === 0;
        if (shared.length > 0)
          components.push({
            factor: 'alias',
            points: pure ? 70 : 40,
            detail: `"${label}" and "${intent.target}" both mean ${shared.join(', ')}`,
          });
        const path = hrefPath(action.href);
        if (path && containsPhrase(normalizeForMatch(path).tokens, wanted))
          components.push({ factor: 'navigation', points: 20, detail: `link to ${path}` });
        if (NAVIGABLE.has(action.category))
          components.push({ factor: 'navigation', points: 10, detail: `${action.category} control` });
        if (action.submitsForm)
          components.push({ factor: 'navigation', points: -30, detail: 'submits a form (not navigation)' });
        const signal = options.history?.signalFor(intentKey, actionTargetSignature(action));
        if (signal && signal.confidence > 0 && components.some((component) => component.points > 0))
          components.push({
            factor: 'history',
            points: Math.round(MAX_HISTORY_POINTS * signal.confidence),
            detail: `historical match ${signal.detail}`,
          });
        return { action, candidate: candidateOf(action.id, label, components) };
      });
    const candidates = rank(scored.map((entry) => entry.candidate));
    const decision = decide(candidates, this.thresholds);
    const best = decision.best ? scored.find((entry) => entry.candidate.id === decision.best?.id) : undefined;
    const base = {
      ...common,
      score: decision.best?.score ?? 0,
      confidence: levelOf(decision.best?.score ?? 0),
      candidates: candidates.slice(0, 5),
    };
    if (decision.status !== 'RESOLVED' || !best)
      return { ...base, status: decision.status, reasons: [decision.reason] };
    return {
      ...base,
      status: 'RESOLVED',
      selected: best.action,
      reasons: [decision.reason, ...best.candidate.components.map(renderComponent)],
      targetSignature: actionTargetSignature(best.action),
    };
  }

  /** Le titre, un titre de section ou le libellé de l'écran nomme-t-il la page demandée ? */
  private currentPage(target: string, context: PageContext): string | undefined {
    const wanted = normalizeForMatch(target).tokens;
    if (wanted.length === 0) return undefined;
    for (const text of [...context.headings.slice(0, 3), context.title, context.stateLabel]) {
      if (!text) continue;
      const tokens = normalizeForMatch(text).tokens;
      if (
        tokens.join(' ') === wanted.join(' ') ||
        (this.dictionary.mentions(target, text) && tokens.length === wanted.length)
      )
        return text;
    }
    return undefined;
  }
}

function hrefPath(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href).pathname;
  } catch {
    return href;
  }
}
