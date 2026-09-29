import type { SemanticHistory } from './semantic-history.js';
import { MAX_HISTORY_POINTS } from './semantic-history.js';
import { matchKey, normalizeForMatch, tokenOverlap } from './normalize.js';
import {
  decide,
  levelOf,
  rank,
  renderComponent,
  candidateOf,
  type ResolutionCandidate,
  type ResolutionStatus,
  type ResolutionThresholds,
  type ScoreComponent,
} from './resolution.js';
import type { SemanticVocabulary } from './vocabulary.js';

export interface OptionChoice {
  /** Libellé visible de l'option (ou de la radio). */
  label: string;
  disabled?: boolean;
  placeholder?: boolean;
  /** Pour une radio : l'id de son action. */
  id?: string;
}

export interface OptionResolution {
  /** UNVERIFIED : options invisibles tant que la liste est fermée (liste personnalisée) : choisie par son texte. */
  status: ResolutionStatus | 'UNVERIFIED';
  /** Le libellé exact à choisir (celui de l'écran). */
  selected?: OptionChoice;
  score: number;
  candidates: ResolutionCandidate[];
  reasons: string[];
}

/**
 * OPTION RESOLVER : « Administrateur » dans la liste « Rôle ». Texte visible, forme
 * normalisée, abréviation, alias, historique. Jamais « la première option » : une
 * option n'est choisie que si elle correspond.
 */
export class OptionResolver {
  constructor(
    private readonly vocabulary: SemanticVocabulary,
    private readonly thresholds: ResolutionThresholds,
  ) {}

  resolve(
    wanted: string,
    options: readonly OptionChoice[] | undefined,
    history?: { intentKey: string; signatureOf(option: OptionChoice): string; history?: SemanticHistory },
  ): OptionResolution {
    if (!options || options.length === 0)
      return {
        status: 'UNVERIFIED',
        selected: { label: wanted },
        score: 0,
        candidates: [],
        reasons: ['options not visible until the list is opened: chosen by its text'],
      };
    const candidates = rank(
      options.flatMap((option, index) => {
        if (option.placeholder) return [];
        const components = this.components(wanted, option);
        const signal =
          history?.history?.signalFor(history.intentKey, history.signatureOf(option)) ?? undefined;
        if (signal && signal.confidence > 0 && components.some((component) => component.points > 0))
          components.push({
            factor: 'history',
            points: Math.round(MAX_HISTORY_POINTS * signal.confidence),
            detail: `chosen before: ${signal.detail}`,
          });
        if (option.disabled) components.push({ factor: 'option', points: -100, detail: 'disabled option' });
        return [candidateOf(option.id ?? `option:${index}`, option.label, components)];
      }),
    );
    const decision = decide(candidates, this.thresholds);
    const selected = decision.best
      ? options.find((option, index) => (option.id ?? `option:${index}`) === decision.best?.id)
      : undefined;
    return {
      status: decision.status,
      ...(decision.status === 'RESOLVED' && selected ? { selected } : {}),
      score: decision.best?.score ?? 0,
      candidates: candidates.slice(0, 5),
      reasons: [
        decision.reason,
        ...(decision.best?.components.map(renderComponent) ?? []),
        ...(decision.best ? [`confidence ${decision.best.score} ${levelOf(decision.best.score)}`] : []),
      ],
    };
  }

  private components(wanted: string, option: OptionChoice): ScoreComponent[] {
    const components: ScoreComponent[] = [];
    const wantedKey = matchKey(wanted);
    const optionKey = matchKey(option.label);
    const wantedTokens = normalizeForMatch(wanted).tokens;
    const optionTokens = normalizeForMatch(option.label).tokens;
    if (option.label.trim() === wanted.trim())
      components.push({ factor: 'option', points: 100, detail: `option "${option.label}" = "${wanted}"` });
    else if (wantedKey !== '' && wantedKey === optionKey)
      components.push({
        factor: 'option',
        points: 90,
        detail: `option "${option.label}" ≈ "${wanted}" (normalized)`,
      });
    else {
      const overlap = tokenOverlap(wantedTokens, optionTokens);
      if (overlap.ratio === 1)
        components.push({
          factor: 'option',
          points: Math.max(30, 70 - 10 * overlap.extra),
          detail: `option "${option.label}" contains "${wanted}"`,
        });
      else if (isAbbreviation(wantedTokens, optionTokens))
        components.push({
          factor: 'option',
          points: 70,
          detail: `"${wanted}" abbreviates option "${option.label}"`,
        });
      else if (overlap.ratio >= 0.5)
        components.push({
          factor: 'option',
          points: Math.round(40 * overlap.ratio),
          detail: `option "${option.label}" shares ${overlap.common} word(s) with "${wanted}"`,
        });
      const wantedConcept = this.vocabulary.conceptOf(wanted);
      const optionConcept = this.vocabulary.conceptOf(option.label);
      if (wantedConcept && optionConcept && wantedConcept.concept === optionConcept.concept)
        components.push({
          factor: 'alias',
          points: 40,
          detail: `"${wanted}" and "${option.label}" both mean ${wantedConcept.concept}`,
        });
    }
    return components;
  }
}

/** « Admin » → « Administrateur » : chaque mot voulu (≥ 3 lettres) commence un mot de l'option, dans l'ordre. */
function isAbbreviation(wanted: readonly string[], option: readonly string[]): boolean {
  if (wanted.length === 0 || wanted.length > option.length) return false;
  let position = 0;
  for (const token of wanted) {
    if (token.length < 3) return false;
    while (position < option.length && !(option[position] ?? '').startsWith(token)) position++;
    if (position >= option.length) return false;
    position++;
  }
  return true;
}
