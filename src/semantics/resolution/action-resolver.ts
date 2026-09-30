import { actionLabel, type DiscoveredAction } from '../../model/discovered-action.js';
import type { SemanticDictionary } from '../semantic-dictionary.js';
import type { ClickIntent, SubmitIntent } from './intent.js';
import { describeIntent } from './intent.js';
import { containsPhrase, matchKey, normalizeForMatch, tokenOverlap } from './normalize.js';
import {
  candidateOf,
  decide,
  levelOf,
  rank,
  renderComponent,
  targetSignature,
  type ResolutionCandidate,
  type ResolutionStatus,
  type ResolutionThresholds,
  type ScoreComponent,
} from './resolution.js';
import { MAX_HISTORY_POINTS, type SemanticHistory } from './semantic-history.js';
import type { SemanticVocabulary } from './vocabulary.js';

export interface ActionResolutionContext {
  stateSignature: string;
  /** Le formulaire des champs remplis juste avant : c'est lui qu'on valide. */
  previousFormGroup?: string;
  history?: SemanticHistory;
}

export interface ActionResolution {
  status: ResolutionStatus;
  intent: string;
  intentKey: string;
  selected?: DiscoveredAction;
  score: number;
  confidence: string;
  candidates: ResolutionCandidate[];
  reasons: string[];
  targetSignature?: string;
}

/** Signature sémantique d'un bouton, d'un lien, d'un onglet (jamais un id DOM). */
export function actionTargetSignature(action: DiscoveredAction): string {
  return targetSignature({
    kind: action.role ?? action.type,
    label: actionLabel(action),
    ...(action.name ? { name: action.name } : {}),
    type: action.elementType,
  });
}

const CLICKABLE = new Set(['click', 'navigate']);

/**
 * ACTION RESOLVER : « je valide le formulaire » → le bouton qui envoie CE formulaire.
 * Pas une recherche du mot « valider » : le rôle du bouton (envoi natif), son sens
 * (Enregistrer, Créer, Confirmer, Save…), son formulaire (celui qu'on vient de
 * remplir), et jamais un bouton qui veut dire autre chose (Annuler, Supprimer).
 */
export class ActionResolver {
  constructor(
    private readonly vocabulary: SemanticVocabulary,
    private readonly dictionary: SemanticDictionary,
    private readonly thresholds: ResolutionThresholds,
  ) {}

  resolveFormAction(
    intent: SubmitIntent,
    actions: readonly DiscoveredAction[],
    context: ActionResolutionContext,
  ): ActionResolution {
    const intentKey = `${intent.action}:${intent.verb ? matchKey(intent.verb) : ''}`;
    const scored = clickable(actions).map((action) => {
      const components: ScoreComponent[] = [];
      const label = actionLabel(action);
      const meaning = this.vocabulary.actionKindOf(label);
      if (meaning?.kind === intent.action)
        components.push({
          factor: 'role',
          points: 70,
          detail: `"${label}" means ${intent.action} ("${meaning.word}")`,
        });
      else if (meaning)
        components.push({
          factor: 'role',
          points: -80,
          detail: `"${label}" means ${meaning.kind}, not ${intent.action}`,
        });
      if (intent.verb && matchKey(label) === matchKey(intent.verb))
        components.push({ factor: 'label', points: 15, detail: `label "${label}" = verb "${intent.verb}"` });
      if (intent.action === 'submit') {
        if (action.nativeSubmit)
          components.push({ factor: 'submit', points: 35, detail: 'button[type=submit] of its form' });
        else if (action.submitsForm)
          components.push({ factor: 'submit', points: 10, detail: 'submits its form' });
        if (action.risks.some((risk) => risk === 'delete' || risk === 'payment' || risk === 'logout'))
          components.push({
            factor: 'role',
            points: -100,
            detail: `risky action (${action.risks.join(', ')})`,
          });
      }
      if (intent.action === 'next' && action.category === 'form-step')
        components.push({ factor: 'submit', points: 20, detail: 'moves the form to its next step' });
      if (context.previousFormGroup) {
        if (action.formGroup === context.previousFormGroup)
          components.push({ factor: 'form', points: 20, detail: 'in the form just filled' });
        else if (action.formGroup !== undefined)
          components.push({ factor: 'form', points: -20, detail: 'in another form' });
      }
      if (action.role === 'button') components.push({ factor: 'kind', points: 5, detail: 'button' });
      if (action.foreground) components.push({ factor: 'context', points: 3, detail: 'in the foreground' });
      this.history(components, context, intentKey, action);
      return { action, candidate: candidateOf(action.id, label, components) };
    });
    return this.conclude(describeIntent(intent), intentKey, scored);
  }

  /** « je clique sur le bouton créer », « je clique sur nouvel utilisateur » : par le nom, le sens et le rôle. */
  resolveClick(
    intent: ClickIntent,
    actions: readonly DiscoveredAction[],
    context: ActionResolutionContext,
  ): ActionResolution {
    const intentKey = `click:${matchKey(intent.target)}`;
    const wanted = normalizeForMatch(intent.target);
    const wantedConcepts = new Set(this.dictionary.conceptsIn(intent.target));
    const scored = clickable(actions).map((action) => {
      const components: ScoreComponent[] = [];
      const label = actionLabel(action);
      nameComponents(components, wanted.tokens, label, intent.target);
      const shared = this.dictionary.conceptsIn(label).filter((concept) => wantedConcepts.has(concept));
      if (shared.length > 0) {
        const rest = restAfterConcepts(this.dictionary, shared, wanted.tokens);
        const covered = tokenOverlap(rest, normalizeForMatch(label).tokens).ratio === 1 || rest.length === 0;
        components.push({
          factor: 'alias',
          points: covered ? 60 : 20,
          detail: `"${label}" and "${intent.target}" both mean ${shared.join(', ')}`,
        });
      }
      if (intent.role)
        components.push(
          action.role === intent.role
            ? { factor: 'role', points: 10, detail: `role ${intent.role}` }
            : {
                factor: 'role',
                points: -10,
                detail: `role ${action.role ?? action.type}, not ${intent.role}`,
              },
        );
      if (action.foreground) components.push({ factor: 'context', points: 3, detail: 'in the foreground' });
      this.history(components, context, intentKey, action);
      return { action, candidate: candidateOf(action.id, label, components) };
    });
    return this.conclude(describeIntent(intent), intentKey, scored);
  }

  private history(
    components: ScoreComponent[],
    context: ActionResolutionContext,
    intentKey: string,
    action: DiscoveredAction,
  ): void {
    const signal = context.history?.signalFor(intentKey, actionTargetSignature(action));
    const plausible = components.reduce((sum, component) => sum + component.points, 0) > 0;
    if (signal && plausible && signal.confidence > 0)
      components.push({
        factor: 'history',
        points: Math.round(MAX_HISTORY_POINTS * signal.confidence),
        detail: `historical match ${signal.detail}`,
      });
  }

  private conclude(
    intent: string,
    intentKey: string,
    scored: { action: DiscoveredAction; candidate: ResolutionCandidate }[],
  ): ActionResolution {
    const candidates = rank(scored.map((entry) => entry.candidate));
    const repeated = repeatedInList(scored, candidates, this.thresholds.autoResolveThreshold);
    const decision = repeated
      ? { status: 'RESOLVED' as const, best: repeated.first.candidate, reason: repeated.reason }
      : decide(candidates, this.thresholds);
    const best = decision.best ? scored.find((entry) => entry.candidate.id === decision.best?.id) : undefined;
    const common = {
      intent,
      intentKey,
      score: decision.best?.score ?? 0,
      confidence: levelOf(decision.best?.score ?? 0),
      candidates: candidates.slice(0, 5),
    };
    if (decision.status !== 'RESOLVED' || !best)
      return { ...common, status: decision.status, reasons: [decision.reason] };
    return {
      ...common,
      status: 'RESOLVED',
      selected: best.action,
      reasons: [decision.reason, ...best.candidate.components.map(renderComponent)],
      targetSignature: actionTargetSignature(best.action),
    };
  }
}

/**
 * Le même contrôle répété dans une liste (« Ouvrir » sur chaque ligne d'un tableau) :
 * les meilleurs candidats ont le même libellé, le même type, le même rôle et le même
 * score. Ce n'est pas une hésitation entre deux cibles : la première ligne est prise, et
 * l'explication le dit. Deux contrôles différents à égalité restent AMBIGUOUS.
 */
function repeatedInList(
  scored: readonly { action: DiscoveredAction; candidate: ResolutionCandidate }[],
  ranked: readonly ResolutionCandidate[],
  threshold: number,
): { first: { action: DiscoveredAction; candidate: ResolutionCandidate }; reason: string } | undefined {
  const [top] = ranked;
  if (!top || top.score < threshold) return undefined;
  const tied = scored.filter((entry) => entry.candidate.points === top.points);
  if (tied.length < 2) return undefined;
  const kind = (action: DiscoveredAction): string =>
    [matchKey(actionLabel(action)), action.type, action.locator.role ?? '', action.category].join('|');
  const [first] = tied;
  if (!first || tied.some((entry) => kind(entry.action) !== kind(first.action))) return undefined;
  return {
    first,
    reason: `"${first.candidate.label}" is repeated ${String(tied.length)} times (a list): the first one`,
  };
}

/** Libellé identique, contenu, ou mots en commun : les mêmes règles que pour les champs. */
export function nameComponents(
  components: ScoreComponent[],
  wanted: readonly string[],
  label: string,
  display: string,
): void {
  const tokens = normalizeForMatch(label).tokens;
  const key = tokens.join(' ');
  if (key !== '' && key === wanted.join(' ')) {
    components.push({ factor: 'label', points: 70, detail: `"${label}" = "${display}"` });
    return;
  }
  if (containsPhrase(tokens, wanted)) {
    components.push({
      factor: 'label',
      points: Math.max(20, 40 - 5 * (tokens.length - wanted.length)),
      detail: `"${label}" contains "${display}"`,
    });
    return;
  }
  if (containsPhrase(wanted, tokens) && tokens.length > 0) {
    components.push({
      factor: 'label',
      points: Math.max(15, 35 - 5 * (wanted.length - tokens.length)),
      detail: `"${display}" contains "${label}"`,
    });
    return;
  }
  const overlap = tokenOverlap(wanted, tokens);
  if (overlap.ratio >= 0.5)
    components.push({
      factor: 'label',
      points: Math.round(20 * overlap.ratio),
      detail: `"${label}" shares ${overlap.common} word(s) with "${display}"`,
    });
}

function clickable(actions: readonly DiscoveredAction[]): DiscoveredAction[] {
  return actions.filter(
    (action) => CLICKABLE.has(action.type) && action.visible && !action.disabled && !action.obscured,
  );
}

/** Les mots voulus qui ne sont pas des mots des concepts partagés (« nouvel utilisateur » − create → [utilisateur]). */
export function restAfterConcepts(
  dictionary: SemanticDictionary,
  concepts: readonly string[],
  wanted: readonly string[],
): string[] {
  const words = new Set(
    concepts.flatMap((concept) =>
      dictionary.wordsOf(concept).flatMap((word) => normalizeForMatch(word).tokens),
    ),
  );
  return wanted.filter((token) => !words.has(token));
}
