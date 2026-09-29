import { stringify } from 'yaml';
import type { FlowExpectation, FlowStep, FlowTarget } from '../config/flow-schema.js';
import type { GherkinIntent } from '../semantics/resolution/intent.js';
import type { FlowIntentGraph } from './flow-intent-graph.js';
import type {
  ObservedFlowGraph,
  Reconciliation,
  ReconciliationStatus,
  SuggestedFlowGraph,
  SuggestedStep,
} from './reconciliation-model.js';

/** Statuts dont l'étape d'origine est gardée pour revue, en commentaire : jamais supprimée, jamais exécutée telle quelle. */
const REVIEW_ONLY = new Set<ReconciliationStatus>(['POSSIBLY_OBSOLETE', 'MISSING', 'UNREACHABLE']);
/** Statuts dont l'étape d'origine reste active, avec une note (le robot n'a pas pu conclure). */
const KEEP_WITH_NOTE = new Set<ReconciliationStatus>([
  'AMBIGUOUS',
  'BLOCKED_BY_POLICY',
  'NOT_VERIFIED',
  'ASSERTION_MISMATCH',
]);

/**
 * SUGGESTED FLOW : construit à la fin, à partir de l'attendu, de l'observé et de la
 * réconciliation — jamais d'une étape « logique » qui n'a pas été vue.
 * - ORIGINAL : l'étape du scénario, retrouvée (MATCHED, REORDERED à sa place observée) ;
 * - OBSERVED : une étape vue pendant ce run (INSERTED, ALTERNATIVE) ;
 * - HISTORICAL_CONFIRMED : proposée par la mémoire ET confirmée sur l'application réelle.
 * Une étape introuvable reste dans la proposition, en commentaire, pour revue.
 */
export function buildSuggestedFlow(
  graph: FlowIntentGraph,
  observed: ObservedFlowGraph,
  reconciliation: Reconciliation,
): SuggestedFlowGraph {
  const intentOf = new Map(graph.intents.map((intent) => [intent.id, intent]));
  const stepOf = new Map(observed.steps.map((step) => [step.id, step]));
  const steps: SuggestedStep[] = [];
  for (const entry of reconciliation.entries) {
    const intent = entry.expectedIntent ? intentOf.get(entry.expectedIntent.id) : undefined;
    const observedStep = entry.observedTarget ? stepOf.get(entry.observedTarget.stepId) : undefined;
    if (intent && !observedStep?.action) {
      const original = {
        provenance: 'ORIGINAL' as const,
        status: entry.status,
        step: intent.step,
        originalText: intent.sourceReference.text,
        label: intent.label,
      };
      if (REVIEW_ONLY.has(entry.status))
        steps.push({ ...original, review: `to review: ${entry.reasons[0] ?? ''}` });
      else if (KEEP_WITH_NOTE.has(entry.status))
        steps.push({ ...original, review: `kept: ${entry.reasons[0] ?? ''}` });
      else steps.push(original);
      continue;
    }
    if (observedStep?.step) {
      steps.push({
        provenance: observedStep.provenance,
        status: entry.status,
        step: observedStep.step,
        label: observedStep.label,
        ...(observedStep.formFields && observedStep.formFields.length > 0 ? { fillFormBefore: true } : {}),
      });
    }
  }
  return {
    name: graph.name,
    source: graph.source,
    ...(graph.startAt ? { startAt: graph.startAt } : {}),
    status: reconciliation.status,
    steps,
  };
}

// ------------------------------------------------------------------ YAML

/**
 * suggested.flow.yaml : le schéma des flows du projet, tel quel (validé par flowSchema).
 * Chaque étape porte en commentaire son statut et sa provenance ; une étape à revoir
 * est entièrement en commentaire.
 */
export function suggestedFlowYaml(suggested: SuggestedFlowGraph, header: string[] = []): string {
  const lines: string[] = [
    ...header.map((line) => `# ${line}`),
    ...(needsSemantic(suggested)
      ? ['# Some steps are intents (FILL_FORM…): run with gherkin.semanticResolution.enabled: true']
      : []),
    ...stringify(
      { name: suggested.name, ...(suggested.startAt ? { startAt: suggested.startAt } : {}) },
      { lineWidth: 0 },
    )
      .trimEnd()
      .split('\n'),
    'steps:',
  ];
  for (const item of suggested.steps) {
    lines.push(`  # ${item.status} · ${item.provenance}${item.review ? ` · ${oneLine(item.review)}` : ''}`);
    const raw: Record<string, unknown>[] = [];
    if (item.fillFormBefore) raw.push({ intent: { kind: 'FILL_FORM' } });
    if (item.step) raw.push(rawStepOf(item.step));
    const text = stringify(raw, { lineWidth: 0 }).trimEnd().split('\n');
    const commented = item.review !== undefined && REVIEW_ONLY.has(item.status);
    for (const line of text) lines.push(commented ? `  # ${line}` : `  ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Une étape (modèle interne) sous la forme écrite dans un flow YAML. */
export function rawStepOf(step: FlowStep): Record<string, unknown> {
  const common: Record<string, unknown> = {
    ...(step.name ? { name: step.name } : {}),
    ...(step.allow.length === 1
      ? { allow: step.allow[0] }
      : step.allow.length > 1
        ? { allow: step.allow }
        : {}),
    ...(step.optional ? { optional: true } : {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
  };
  switch (step.kind) {
    case 'goto':
      return { goto: step.url, ...common };
    case 'click':
    case 'check':
    case 'uncheck':
      return { [step.kind]: rawTarget(step.target), ...common };
    case 'fill':
      return { fill: { ...rawTarget(step.target), value: step.value }, ...common };
    case 'select':
      return { select: { ...rawTarget(step.target), option: step.option }, ...common };
    case 'expect':
      return { expect: rawExpectation(step.expect), ...common };
    case 'screenshot':
      return { screenshot: step.label, ...common };
    case 'manual':
      return { manual: step.text, ...common };
    case 'auto':
      return { auto: { sentence: step.sentence, type: step.type }, ...common };
    case 'intent':
      return { intent: step.intent, ...common };
  }
}

function rawTarget(target: FlowTarget): Record<string, unknown> {
  const options = {
    ...(target.exact !== undefined ? { exact: target.exact } : {}),
    ...(target.nth !== undefined ? { nth: target.nth } : {}),
  };
  if (target.strategy === 'role')
    return { role: target.role, ...(target.name !== undefined ? { name: target.name } : {}), ...options };
  return { [target.strategy]: target.value, ...options };
}

function rawExpectation(expectation: FlowExpectation): Record<string, unknown> {
  return {
    ...(expectation.text !== undefined ? { text: expectation.text } : {}),
    ...(expectation.url !== undefined ? { url: expectation.url } : {}),
    ...(expectation.visible ? { visible: rawTarget(expectation.visible) } : {}),
    ...(expectation.hidden ? { hidden: rawTarget(expectation.hidden) } : {}),
    ...(expectation.noError ? { noError: true } : {}),
    ...(expectation.response ? { response: expectation.response } : {}),
  };
}

// ------------------------------------------------------------------ Gherkin

type Language = 'fr' | 'en';
type Kind = 'given' | 'when' | 'then';

const KEYWORDS: Record<Language, Record<Kind | 'and', string>> = {
  fr: { given: 'Étant donné que', when: 'Quand', then: 'Alors', and: 'Et' },
  en: { given: 'Given', when: 'When', then: 'Then', and: 'And' },
};

/**
 * suggested.feature : les phrases du projet (phrases intégrées et phrases d'intention,
 * jamais un sélecteur CSS/XPath). Une phrase d'origine d'un `.feature` est reprise telle
 * quelle : elle se lit déjà, phrases de l'équipe comprises.
 */
export function suggestedFeature(
  suggested: SuggestedFlowGraph,
  options: { language?: Language; header?: string[] } = {},
): string {
  const language = options.language ?? 'fr';
  const allows = new Set(suggested.steps.flatMap((item) => item.step?.allow ?? []));
  const tags = [
    ...(allows.has('MUTATION') ? ['@mutation'] : []),
    ...(allows.has('DANGEROUS') ? ['@dangerous'] : []),
    ...(allows.has('UNKNOWN') ? ['@unknown'] : []),
  ];
  const lines: string[] = [
    ...(language === 'fr' ? ['# language: fr'] : []),
    ...(options.header ?? []).map((line) => `# ${line}`),
    ...(needsSemantic(suggested)
      ? ['# Some sentences are intents: run with gherkin.semanticResolution.enabled: true']
      : []),
    ...(tags.length > 0 ? [tags.join(' ')] : []),
    `${language === 'fr' ? 'Fonctionnalité' : 'Feature'}: ${suggested.name}`,
    '',
    `  ${language === 'fr' ? 'Scénario' : 'Scenario'}: ${suggested.name}`,
  ];
  let previous: Kind | undefined;
  const keyword = (kind: Kind): string => {
    // Un « Alors » ne revient jamais à « Quand » : après une vérification, une action reprend avec « Et ».
    const word = previous === kind ? KEYWORDS[language].and : KEYWORDS[language][kind];
    previous = kind;
    return word;
  };
  for (const item of suggested.steps) {
    const note = `${item.status} · ${item.provenance}${item.review ? ` · ${oneLine(item.review)}` : ''}`;
    lines.push(`    # ${note}`);
    const commented = item.review !== undefined && REVIEW_ONLY.has(item.status);
    const sentences: [Kind, string][] = [];
    if (item.fillFormBefore)
      sentences.push(['when', language === 'fr' ? 'je remplis le formulaire' : 'I fill in the form']);
    if (item.step) {
      const original =
        suggested.source.type === 'GHERKIN' && item.provenance === 'ORIGINAL' ? item.originalText : undefined;
      const kind = kindOf(item.step);
      const sentence = original ? stripKeyword(original) : sentenceOf(item.step, language);
      if (sentence) sentences.push([kind, sentence]);
      else lines.push(`    # (no Gherkin sentence for this step without a selector: ${item.label})`);
    }
    const verbatim =
      suggested.source.type === 'GHERKIN' && item.provenance === 'ORIGINAL' ? item.originalText : undefined;
    for (const [kind, sentence] of sentences) {
      // Une phrase à revoir est recopiée telle qu'écrite dans le scénario, en commentaire.
      if (commented) lines.push(`    # ${verbatim ?? `${KEYWORDS[language][kind]} ${sentence}`}`);
      else lines.push(`    ${keyword(kind)} ${sentence}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function kindOf(step: FlowStep): Kind {
  if (step.kind === 'expect' || (step.kind === 'intent' && step.intent.kind === 'ASSERT')) return 'then';
  if (
    step.kind === 'goto' ||
    (step.kind === 'intent' && step.intent.kind === 'NAVIGATE' && step.intent.precondition)
  )
    return 'given';
  return 'when';
}

const ORIGINAL_KEYWORD =
  /^(Étant donné qu['’]|Étant donné que|Étant donné|Etant donné que|Soit|Quand|Lorsque|Lorsqu['’]|Alors|Et que|Et|Mais|Given|When|Then|And|But)\s*/i;

function stripKeyword(text: string): string {
  return text.replace(ORIGINAL_KEYWORD, '').trim();
}

function quote(value: string | { env: string }): string {
  return typeof value === 'string' ? `"${value}"` : `"<env:${value.env}>"`;
}

const ROLE_WORDS: Record<Language, Record<string, string>> = {
  fr: { button: 'le bouton ', link: 'le lien ', tab: "l'onglet ", menuitem: 'le menu ' },
  en: { button: 'the button ', link: 'the link ', tab: 'the tab ', menuitem: 'the menu item ' },
};

function targetWords(target: FlowTarget, language: Language): string | undefined {
  if (target.strategy === 'role')
    return target.name !== undefined
      ? `${ROLE_WORDS[language][target.role ?? ''] ?? ''}"${target.name}"`
      : undefined;
  if (target.strategy === 'text' || target.strategy === 'label') return `"${target.value ?? ''}"`;
  return undefined;
}

function fieldName(target: FlowTarget): string | undefined {
  if (target.strategy === 'label' || target.strategy === 'text') return target.value;
  if (target.strategy === 'role') return target.name;
  return undefined;
}

/** Une étape → une phrase intégrée (ou d'intention) ; undefined si elle ne se dit pas sans sélecteur. */
export function sentenceOf(step: FlowStep, language: Language = 'fr'): string | undefined {
  const fr = language === 'fr';
  switch (step.kind) {
    case 'goto':
      return fr ? `je suis sur "${step.url}"` : `I am on "${step.url}"`;
    case 'click': {
      const words = targetWords(step.target, language);
      return words ? (fr ? `je clique sur ${words}` : `I click ${words}`) : undefined;
    }
    case 'fill': {
      const field = fieldName(step.target);
      return field
        ? fr
          ? `je saisis ${quote(step.value)} dans "${field}"`
          : `I type ${quote(step.value)} into "${field}"`
        : undefined;
    }
    case 'select': {
      const field = fieldName(step.target);
      return field
        ? fr
          ? `je choisis "${step.option}" dans "${field}"`
          : `I select "${step.option}" from "${field}"`
        : undefined;
    }
    case 'check':
    case 'uncheck': {
      const field = fieldName(step.target);
      if (!field) return undefined;
      if (step.kind === 'check') return fr ? `je coche la case "${field}"` : `I check "${field}"`;
      return fr ? `je décoche "${field}"` : `I uncheck "${field}"`;
    }
    case 'expect':
      return expectationSentence(step.expect, language);
    case 'manual':
      return undefined;
    case 'screenshot':
      return fr ? `je prends une capture "${step.label}"` : `I take a screenshot "${step.label}"`;
    case 'auto':
      return step.sentence;
    case 'intent':
      return intentSentence(step.intent, language);
  }
}

function expectationSentence(expectation: FlowExpectation, language: Language): string | undefined {
  const fr = language === 'fr';
  if (expectation.text !== undefined)
    return fr ? `je vois "${expectation.text}"` : `I should see "${expectation.text}"`;
  if (expectation.url !== undefined)
    return fr ? `l'URL contient "${expectation.url}"` : `the URL contains "${expectation.url}"`;
  if (expectation.visible) {
    const words = targetWords(expectation.visible, language);
    return words ? (fr ? `je vois ${words}` : `I should see ${words}`) : undefined;
  }
  if (expectation.hidden) {
    const name = fieldName(expectation.hidden);
    return name ? (fr ? `je ne vois pas "${name}"` : `I should not see "${name}"`) : undefined;
  }
  if (expectation.noError)
    return fr ? "aucun message d'erreur n'est affiché" : 'no error message is displayed';
  return undefined;
}

function intentSentence(intent: GherkinIntent, language: Language): string {
  const fr = language === 'fr';
  switch (intent.kind) {
    case 'NAVIGATE':
      return intent.precondition
        ? fr
          ? `je suis sur la page ${intent.target}`
          : `I am on the ${intent.target} page`
        : fr
          ? `j'accède à "${intent.target}"`
          : `I go to "${intent.target}"`;
    case 'CLICK':
      return fr ? `je clique sur "${intent.target}"` : `I click on "${intent.target}"`;
    case 'FILL':
      return fr
        ? `je renseigne ${intent.field} avec ${quote(intent.value)}`
        : `I fill in ${intent.field} with ${quote(intent.value)}`;
    case 'SELECT':
      return fr
        ? `je sélectionne "${intent.option}" comme ${intent.field}`
        : `I select "${intent.option}" as ${intent.field}`;
    case 'CHECK':
      return intent.checked
        ? fr
          ? `je coche ${intent.field}`
          : `I check ${intent.field}`
        : fr
          ? `je décoche ${intent.field}`
          : `I uncheck ${intent.field}`;
    case 'UPLOAD':
      return fr
        ? `je joins "${intent.file}" dans ${intent.field}`
        : `I upload "${intent.file}" to ${intent.field}`;
    case 'SUBMIT':
      switch (intent.action) {
        case 'cancel':
          return fr ? "j'annule" : 'I cancel';
        case 'next':
          return fr ? "je passe à l'étape suivante" : 'I continue';
        case 'previous':
          return fr ? 'je reviens en arrière' : 'I go back';
        case 'submit':
          return intent.verb === 'enregistrer'
            ? fr
              ? "j'enregistre"
              : 'I save'
            : fr
              ? 'je valide le formulaire'
              : 'I submit the form';
      }
      break;
    case 'FILL_FORM':
      return fr
        ? `je remplis le formulaire${intent.form ? ` ${intent.form}` : ''}`
        : `I fill in the${intent.form ? ` ${intent.form}` : ''} form`;
    case 'ASSERT':
      switch (intent.assertion) {
        case 'MESSAGE':
          return intent.message === 'error'
            ? fr
              ? "un message d'erreur est affiché"
              : 'an error message is displayed'
            : fr
              ? 'un message de confirmation est affiché'
              : 'a confirmation message is displayed';
        case 'PAGE_DISPLAYED':
          return fr
            ? `la page ${intent.subject ?? ''} est affichée`
            : `the ${intent.subject ?? ''} page is displayed`;
        case 'ENTITY_VISIBLE':
          return fr
            ? `${article(intent.subject)} doit apparaître dans la liste`
            : `the ${intent.subject ?? 'item'} should appear in the list`;
        case 'ENTITY_CREATED':
          return fr
            ? `${article(intent.subject)} doit être créé`
            : `the ${intent.subject ?? 'item'} should be created`;
      }
  }
  return '';
}

function article(subject: string | undefined): string {
  if (!subject) return "l'élément";
  return /^[aeiouyhéèê]/i.test(subject) ? `l'${subject}` : `le ${subject}`;
}

function needsSemantic(suggested: SuggestedFlowGraph): boolean {
  return suggested.steps.some(
    (item) => item.review === undefined && (item.fillFormBefore === true || item.step?.kind === 'intent'),
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 160);
}
