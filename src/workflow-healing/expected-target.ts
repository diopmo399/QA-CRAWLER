import { normalize } from '../flows/action-effect-verifier.js';
import type { Evidence, RootCauseCandidate, ScreenControl, SemanticAction } from './model.js';
import { labelSimilarity, round, slugOf } from './similarity.js';

/** Ce que le navigateur dit du localisateur ENREGISTRÉ (sans rien cliquer). */
export interface TargetProbe {
  /** Un élément correspond au localisateur dans le DOM. */
  attached: boolean;
  visible: boolean;
  /** Il a pu être lu (rôle, nom) : faux s'il a disparu ou été re-rendu entre-temps. */
  readable: boolean;
  enabled?: boolean;
}

/** Une étape enregistrée avant la cible, avec ce qu'elle a appris à l'enregistrement. */
export interface RecordedStepView {
  index: number;
  action: SemanticAction;
  /** effects.appears de l'étape (« textbox:Company name »…). */
  appears: string[];
}

/** Une cause connue qui rend la cible disponible (graphe de dépendances, graphe causal…). */
export interface KnownRevealer {
  role: string;
  name: string;
  source: 'DEPENDENCY' | 'CAUSAL' | 'STATIC';
  /** HYPOTHESIS / SUPPORTED / RUNTIME_CONFIRMED : une relation seulement supposée n'est pas une vérité. */
  status?: string;
  detail: string;
}

export type TargetPresence = 'PRESENT' | 'PRESENT_SIMILAR' | 'HIDDEN' | 'UNSTABLE' | 'ABSENT';

/** Ce qui rendait la cible disponible pendant l'enregistrement (ou d'après les connaissances). */
export interface TargetRevealer {
  role?: string;
  label: string;
  kind: string;
  step?: number;
  source: 'RECORDED_EFFECT' | 'PREVIOUS_CHOICE' | 'DEPENDENCY' | 'CAUSAL' | 'STATIC';
  /** Le contrôle qui la révèle est à l'écran maintenant. */
  onScreen: boolean;
  /** Supposé seulement (hypothèse) : à vérifier, jamais tenu pour vrai. */
  hypothetical: boolean;
}

/**
 * EXPECTED TARGET ANALYSIS : avant de réparer un SÉLECTEUR, comprendre la CIBLE.
 *
 *   le champ existe-t-il fonctionnellement ? sinon : qu'est-ce qui le rend disponible ?
 *   (effets appris à l'enregistrement, choix précédent, dépendances, graphe causal, section parente)
 */
export interface ExpectedTargetAnalysis {
  target: {
    label: string;
    role?: string;
    kind: string;
    field: boolean;
    /** Une identité vérifiable (nom, texte, test id) a été enregistrée. */
    identifiable: boolean;
  };
  presence: TargetPresence;
  /** Contrôles proches à l'écran (même rôle, nom voisin) : un localisateur périmé possible. */
  semanticMatches: string[];
  parentSection?: { label: string; state: 'CLOSED' | 'UNSELECTED_TAB'; evidence: string };
  revealers: TargetRevealer[];
  /** FILL X ← X_AVAILABLE ← SECTION_OPEN ← CHOICE_MADE (du but vers la cause). */
  preconditionChain: string[];
  missingPreconditions: string[];
  /** Les causes FONCTIONNELLES rééquilibrées (le symptôme technique n'en est pas une). */
  rootCauses: RootCauseCandidate[];
  /** La cible n'existe pas fonctionnellement : réparer le localisateur ne sert à rien. */
  functionalRecovery: boolean;
  evidence: Evidence[];
}

const REVEALING_ROLES = new Set([
  'tab',
  'button',
  'link',
  'menuitem',
  'treeitem',
  'checkbox',
  'radio',
  'switch',
]);

/**
 * Analyse PURE de la cible attendue : présence réelle, voisins sémantiques, section parente,
 * actions qui la révèlent, chaîne de préconditions et causes fonctionnelles.
 *
 * LOCATOR_STALE n'est fort que si le contrôle fonctionnel SEMBLE présent (même rôle, nom voisin).
 * Une cible absente est TARGET_NOT_RENDERED — et l'analyse demande POURQUOI : section fermée,
 * précondition manquante, mauvais état du parcours.
 */
export function analyzeExpectedTarget(input: {
  current: SemanticAction;
  identifiable: boolean;
  probe: TargetProbe;
  controls: readonly ScreenControl[];
  previous: readonly RecordedStepView[];
  /** L'étape précédente n'a produit son effet que provisoirement (attendu ≠ observé). */
  previousDeferred?: boolean;
  revealers?: readonly KnownRevealer[];
  synonyms?: (term: string) => readonly string[];
}): ExpectedTargetAnalysis {
  const { current, probe } = input;
  const visible = input.controls.filter((control) => control.visible);
  const evidence: Evidence[] = [];
  const label = current.label;
  const subject = slugOf(label) || 'TARGET';
  const wantedRole = current.role ?? (current.field ? 'textbox' : undefined);

  // ---- présence réelle
  const similar = input.identifiable
    ? visible
        .filter((control) => !wantedRole || control.role === wantedRole || (current.field && control.field))
        .map((control) => ({ control, similarity: labelSimilarity(control.name, label, input.synonyms) }))
        .filter((entry) => entry.similarity >= 0.5)
        .sort((a, b) => b.similarity - a.similarity)
    : [];
  const semanticMatches = similar.slice(0, 3).map((entry) => `${entry.control.role}:${entry.control.name}`);
  const presence: TargetPresence =
    probe.attached && probe.visible && !probe.readable
      ? 'UNSTABLE'
      : probe.attached && probe.visible
        ? 'PRESENT'
        : similar.length > 0
          ? 'PRESENT_SIMILAR'
          : probe.attached
            ? 'HIDDEN'
            : 'ABSENT';
  evidence.push({
    source: 'RUNTIME',
    detail:
      presence === 'PRESENT'
        ? `the recorded locator designates a visible element`
        : presence === 'UNSTABLE'
          ? 'the located element disappeared before it could be read (re-rendered)'
          : presence === 'PRESENT_SIMILAR'
            ? `"${label}" is not there, but ${semanticMatches.join(', ')} looks like it`
            : presence === 'HIDDEN'
              ? 'the recorded element exists but is not visible'
              : `"${label}" is not rendered (no element, no similar control)`,
  });

  // ---- qu'est-ce qui la rend disponible ?
  const onScreen = (role: string | undefined, name: string): boolean =>
    visible.some(
      (control) =>
        (!role || control.role === role) && normalize(control.name) === normalize(name) && !control.disabled,
    );
  const revealers: TargetRevealer[] = [];
  const wanted = normalize(label);
  for (const step of [...input.previous].reverse()) {
    const recorded = step.appears.some((entry) => {
      const name = normalize(entry.slice(entry.indexOf(':') + 1));
      return name === wanted || (name.length > 0 && labelSimilarity(name, wanted) >= 0.9);
    });
    if (recorded)
      revealers.push({
        ...(step.action.role ? { role: step.action.role } : {}),
        label: step.action.label,
        kind: step.action.kind,
        step: step.index,
        source: 'RECORDED_EFFECT',
        onScreen: onScreen(step.action.role, step.action.label),
        hypothetical: false,
      });
  }
  // Le choix juste avant un champ (select, case) le révèle souvent : une hypothèse, pas une vérité.
  const before = input.previous.at(-1);
  if (
    current.field &&
    before &&
    ['select', 'check', 'click'].includes(before.action.kind) &&
    !revealers.some((revealer) => revealer.step === before.index)
  )
    revealers.push({
      ...(before.action.role ? { role: before.action.role } : {}),
      label: before.action.label,
      kind: before.action.kind,
      step: before.index,
      source: 'PREVIOUS_CHOICE',
      onScreen: onScreen(before.action.role, before.action.label),
      hypothetical: true,
    });
  for (const known of input.revealers ?? [])
    revealers.push({
      role: known.role,
      label: known.name,
      kind: known.role === 'checkbox' || known.role === 'radio' ? 'check' : 'click',
      source: known.source,
      onScreen: onScreen(known.role, known.name),
      hypothetical: known.status !== 'RUNTIME_CONFIRMED',
    });

  // ---- section parente : repliée, onglet non sélectionné
  const collapsed = visible.filter(
    (control) => control.expanded === false && REVEALING_ROLES.has(control.role),
  );
  const tabs = visible.filter((control) => control.role === 'tab' && control.selected === false);
  const related = (control: ScreenControl): number =>
    Math.max(
      labelSimilarity(control.name, label, input.synonyms),
      ...revealers.map((revealer) => labelSimilarity(control.name, revealer.label)),
    );
  const closedSection = [...collapsed].sort((a, b) => related(b) - related(a))[0];
  const otherTab = [...tabs].sort((a, b) => related(b) - related(a))[0];
  const parentSection = closedSection
    ? {
        label: `${closedSection.role}:${closedSection.name}`,
        state: 'CLOSED' as const,
        evidence: `"${closedSection.name}" is collapsed (aria-expanded=false)`,
      }
    : otherTab
      ? {
          label: `tab:${otherTab.name}`,
          state: 'UNSELECTED_TAB' as const,
          evidence: `tab "${otherTab.name}" is not selected`,
        }
      : undefined;

  // ---- chaîne de préconditions (du but vers la cause la plus profonde)
  const chain = [`${current.kind.toUpperCase()} ${label}`, `${subject}_AVAILABLE`];
  const missing: string[] = [];
  const absent = presence === 'ABSENT' || presence === 'HIDDEN';
  if (absent && parentSection) {
    const section = `${slugOf(parentSection.label.slice(parentSection.label.indexOf(':') + 1)) || 'PARENT'}_SECTION_OPEN`;
    chain.push(section);
    missing.push(section);
  }
  const strongest = revealers.find((revealer) => !revealer.hypothetical) ?? revealers[0];
  if (absent && strongest) {
    const condition = `${slugOf(strongest.label) || 'PREVIOUS'}_${strongest.kind === 'select' || strongest.kind === 'check' ? 'CHOSEN' : 'DONE'}`;
    chain.push(condition);
    missing.push(condition);
  }

  // ---- causes fonctionnelles, rééquilibrées
  const causes: RootCauseCandidate[] = [];
  const add = (
    category: RootCauseCandidate['category'],
    confidence: number,
    detail: string,
    source: Evidence['source'] = 'RUNTIME',
  ): void => {
    causes.push({ category, confidence: round(confidence), evidence: [{ source, detail }] });
  };
  if (presence === 'PRESENT_SIMILAR')
    // Le contrôle fonctionnel semble là, sous un autre nom : un localisateur périmé.
    add('LOCATOR_STALE', 0.85, `${semanticMatches[0] ?? ''} has the same role and a close name`);
  else if (presence === 'PRESENT')
    add('LOCATOR_STALE', 0.6, 'the locator finds an element, but not the recorded one');
  else if (presence === 'UNSTABLE')
    add('ASYNC_DATA_NOT_READY', 0.6, 'the element is re-rendered while it is read');
  else {
    add('TARGET_NOT_RENDERED', 0.7, `"${label}" is not rendered`);
    // Un localisateur ne peut pas être « périmé » vers une cible qui n'existe pas.
    add('LOCATOR_STALE', 0.15, 'no element of the same kind with a close name');
    if (parentSection)
      add(
        'PARENT_SECTION_CLOSED',
        parentSection.state === 'CLOSED' ? (strongest?.onScreen === false ? 0.75 : 0.65) : 0.55,
        parentSection.evidence,
      );
    if (strongest) {
      const confirmedSource = !strongest.hypothetical;
      add(
        input.previousDeferred ? 'WRONG_WORKFLOW_STATE' : 'PREREQUISITE_MISSING',
        input.previousDeferred ? 0.75 : confirmedSource ? 0.72 : 0.6,
        `${strongest.kind} "${strongest.label}"${strongest.step !== undefined ? ` (step ${String(strongest.step)})` : ''} ${confirmedSource ? 'revealed it during the recording' : 'probably reveals it (hypothesis)'}`,
        strongest.source === 'RECORDED_EFFECT' || strongest.source === 'PREVIOUS_CHOICE'
          ? 'RECORDING'
          : 'DEPENDENCY',
      );
    } else if (input.previousDeferred)
      add('WRONG_WORKFLOW_STATE', 0.65, 'the previous step did not produce its recorded effect', 'CONTEXT');
  }
  causes.sort((a, b) => b.confidence - a.confidence);
  return {
    target: {
      label,
      ...(current.role ? { role: current.role } : {}),
      kind: current.kind,
      field: current.field === true,
      identifiable: input.identifiable,
    },
    presence,
    semanticMatches,
    ...(parentSection ? { parentSection } : {}),
    revealers,
    preconditionChain: chain,
    missingPreconditions: missing,
    rootCauses: causes,
    functionalRecovery: absent,
    evidence: [
      ...evidence,
      ...revealers.slice(0, 3).map((revealer): Evidence => ({
        source:
          revealer.source === 'RECORDED_EFFECT' || revealer.source === 'PREVIOUS_CHOICE'
            ? 'RECORDING'
            : 'DEPENDENCY',
        detail: `${revealer.kind} "${revealer.label}" ${revealer.hypothetical ? 'may reveal' : 'revealed'} it (${revealer.source}${revealer.onScreen ? ', on screen' : ', not on screen'})`,
      })),
    ],
  };
}
