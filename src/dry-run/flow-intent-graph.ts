import type { FlowAllowance, FlowConfig, FlowStep, FlowTarget } from '../config/flow-schema.js';
import { slug } from '../knowledge/signatures.js';
import type { IntentValue } from '../semantics/resolution/intent.js';

/**
 * FLOW INTENT GRAPH : le flow ATTENDU (écrit par le développeur), réduit à ce qu'il
 * demande — une suite ordonnée d'intentions, sans la syntaxe d'origine.
 *
 * Les deux formats arrivent déjà au même modèle avant ce point : un `.feature` et un
 * `flow.yaml` sont chargés par `parseConfig` (lecteur Cucumber, phrases intégrées,
 * phrases de l'équipe, résolution sémantique, `run:`) en `FlowConfig` / `FlowStep`.
 * La normalisation part donc de `FlowStep` : une seule, pour les deux formats. Chaque
 * intention garde l'étape d'origine (`step`), qui reste la seule chose exécutée.
 */

export const FLOW_INTENT_TYPES = [
  'NAVIGATE',
  'CLICK',
  'FILL',
  'SELECT',
  'CHECK',
  'UPLOAD',
  'SUBMIT',
  'ASSERT',
  'CUSTOM',
] as const;
export type FlowIntentType = (typeof FLOW_INTENT_TYPES)[number];

export type FlowSourceType = 'GHERKIN' | 'YAML';

export interface FlowIntent {
  /** `<flow>#<position>` : stable pour un même fichier. */
  id: string;
  /** Position dans le flow attendu, à partir de 1. */
  index: number;
  type: FlowIntentType;
  /** La cible sous une forme comparable : « Créer un utilisateur » → « creer-un-utilisateur ». */
  semanticTarget: string;
  /** La cible telle qu'écrite (libellé, nom, texte, adresse). */
  label: string;
  /** Valeur saisie ou choisie ; `{ env }` n'est jamais résolue ici. */
  value?: IntentValue;
  /** Une intention facultative (`optional`, vérification manuelle) n'invalide pas le flow. */
  required: boolean;
  sourceReference: { file?: string; line?: number; step: number; text: string };
  /** L'étape d'origine : la seule chose exécutée, avec sa propre SafetyPolicy. */
  step: FlowStep;
  /** Les permissions de l'étape (tags @mutation…). */
  allow: FlowAllowance[];
}

export interface FlowIntentGraph {
  id: string;
  name: string;
  source: { type: FlowSourceType; file?: string };
  /** Page de départ du flow (startAt), si le flow en donne une. */
  startAt?: string;
  intents: FlowIntent[];
  metadata?: Record<string, unknown>;
}

/** Clics qui valident un formulaire : la même intention qu'un « je valide le formulaire ». */
const SUBMIT_WORDS =
  /^(valider|valide|enregistrer|enregistre|soumettre|soumets|confirmer|confirme|sauvegarder|sauvegarde|envoyer|save|submit|confirm|validate|send)\b/i;

/**
 * FlowConfig → FlowIntentGraph. `featureText` (le contenu du `.feature`) permet de
 * retrouver la ligne de chaque phrase ; sans lui, seule la position est connue.
 */
export function toFlowIntentGraph(
  flow: FlowConfig,
  source: { type: FlowSourceType; file?: string; featureText?: string },
): FlowIntentGraph {
  const flowId = slug(flow.name) || 'flow';
  const lines = source.featureText ? locator(source.featureText) : undefined;
  const intents: FlowIntent[] = [];
  flow.steps.forEach((step, position) => {
    const described = describeIntentOf(step);
    if (!described) return;
    const text = step.name ?? described.label;
    const line = lines?.(text);
    intents.push({
      id: `${flowId}#${String(position + 1)}`,
      index: position + 1,
      type: described.type,
      // « / » : la page d'accueil, comme les signatures d'écran (stateSignature).
      semanticTarget:
        slug(described.label) || (described.type === 'NAVIGATE' ? 'home' : described.type.toLowerCase()),
      label: described.label,
      ...(described.value !== undefined ? { value: described.value } : {}),
      required: !step.optional && described.manual !== true,
      sourceReference: {
        ...(source.file ? { file: source.file } : {}),
        ...(line !== undefined ? { line } : {}),
        step: position + 1,
        text,
      },
      step,
      allow: [...step.allow],
    });
  });
  return {
    id: flowId,
    name: flow.name,
    source: { type: source.type, ...(source.file ? { file: source.file } : {}) },
    ...(flow.startAt ? { startAt: flow.startAt } : {}),
    intents,
    ...(flow.description ? { metadata: { description: flow.description } } : {}),
  };
}

/** Deux intentions demandent-elles la même chose (type, cible, valeur) ? */
export function sameIntent(a: FlowIntent, b: FlowIntent): boolean {
  return (
    a.type === b.type &&
    a.semanticTarget === b.semanticTarget &&
    JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null)
  );
}

/** Une intention en une ligne ; une valeur n'est jamais affichée (elle peut être sensible). */
export function describeFlowIntent(intent: Pick<FlowIntent, 'type' | 'label' | 'value'>): string {
  const value = intent.value === undefined ? '' : typeof intent.value === 'string' ? ' = "…"' : ' = ${env}';
  return `${intent.type} "${intent.label}"${value}`;
}

interface Described {
  type: FlowIntentType;
  label: string;
  value?: IntentValue;
  manual?: boolean;
}

function describeIntentOf(step: FlowStep): Described | undefined {
  switch (step.kind) {
    case 'goto':
      return { type: 'NAVIGATE', label: step.url };
    case 'click': {
      const label = targetLabel(step.target);
      return { type: SUBMIT_WORDS.test(label) ? 'SUBMIT' : 'CLICK', label };
    }
    case 'fill':
      return { type: 'FILL', label: targetLabel(step.target), value: step.value };
    case 'select':
      return { type: 'SELECT', label: targetLabel(step.target), value: step.option };
    case 'check':
    case 'uncheck':
      return { type: 'CHECK', label: targetLabel(step.target), value: String(step.kind === 'check') };
    case 'expect': {
      const e = step.expect;
      const label =
        e.text ??
        e.url ??
        (e.visible ? targetLabel(e.visible) : undefined) ??
        (e.hidden ? `not ${targetLabel(e.hidden)}` : undefined) ??
        (e.response ? e.response.url : undefined) ??
        'no error';
      return { type: 'ASSERT', label };
    }
    case 'intent': {
      const i = step.intent;
      switch (i.kind) {
        case 'NAVIGATE':
          return { type: 'NAVIGATE', label: i.target };
        case 'CLICK':
          return { type: SUBMIT_WORDS.test(i.target) ? 'SUBMIT' : 'CLICK', label: i.target };
        case 'FILL':
          return { type: 'FILL', label: i.field, value: i.value };
        case 'SELECT':
          return { type: 'SELECT', label: i.field, value: i.option };
        case 'CHECK':
          return { type: 'CHECK', label: i.field, value: String(i.checked) };
        case 'UPLOAD':
          return { type: 'UPLOAD', label: i.field };
        case 'SUBMIT':
          return { type: 'SUBMIT', label: i.verb ?? i.action };
        case 'FILL_FORM':
          return { type: 'FILL', label: i.form ?? 'form' };
        case 'ASSERT':
          return { type: 'ASSERT', label: i.subject ?? i.assertion.toLowerCase() };
      }
      break;
    }
    case 'auto':
      return { type: 'CUSTOM', label: step.sentence };
    case 'manual':
      return { type: 'CUSTOM', label: step.text, manual: true };
    case 'screenshot':
      // Une capture n'est pas une intention de l'application.
      return undefined;
    case 'dragAndDrop':
      return { type: 'CUSTOM', label: `drag ${step.item}` };
  }
  return undefined;
}

function targetLabel(target: FlowTarget): string {
  return (target.strategy === 'role' ? target.name : target.value) ?? target.role ?? '';
}

/**
 * La ligne de chaque phrase dans le `.feature`, dans l'ordre : une phrase est cherchée
 * après la précédente, telle quelle, puis comme un modèle de Plan du scénario
 * (`<Code>` remplacé par la valeur des exemples).
 */
function locator(featureText: string): (text: string) => number | undefined {
  const lines = featureText.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, ' '));
  let after = 0;
  let previous: { wanted: string; line: number } | undefined;
  return (text) => {
    const wanted = text.replace(/\s+\([^()]*\)$/, '').trim();
    // Une phrase qui donne plusieurs étapes (phrase de l'équipe) : la même ligne pour chacune.
    if (previous && previous.wanted === wanted) return previous.line;
    const find = (test: (line: string) => boolean): number | undefined => {
      for (let index = after; index < lines.length; index++) if (test(lines[index] ?? '')) return index;
      return undefined;
    };
    const found =
      find((line) => line === wanted) ??
      find((line) => {
        if (!line.includes('<')) return false;
        const pattern = line
          .split(/<[^>]+>/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.+');
        return new RegExp(`^${pattern}$`).test(wanted);
      });
    if (found === undefined) return undefined;
    after = found + 1;
    previous = { wanted, line: found + 1 };
    return found + 1;
  };
}
