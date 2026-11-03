import { randomBytes } from 'node:crypto';
import type {
  AccessActionKind,
  AccessAnalysis,
  AccessCandidate,
  AccessElementKind,
  AccessInterpretation,
  AccessLead,
  AccessPathStep,
  AccessStep,
  IncidentAccess,
  IncidentAccessInput,
} from '../sdk/core/incident-contracts.js';
import {
  ACCESS_MODES,
  MAX_ACCESS_FIELD,
  MAX_ACCESS_STEP,
  MAX_ACCESS_STEPS,
  MAX_ACCESS_TEXT,
} from '../sdk/core/incident-contracts.js';
import type {
  AngularModel,
  AngularNodeKind,
  IncidentBrief,
  ScopeGraph,
  SilentFailureKind,
} from '../sdk/core/incident-trigger-contracts.js';
import { redactText } from '../security/redactor.js';

/**
 * LE SCÉNARIO D'ACCÈS : la saisie de la personne (texte libre, étapes, données de test sans secret)
 * devient un parcours structuré (actions, cibles, éléments, événement critique), puis des portions de
 * code candidates à partir de la découverte du périmètre (`discoverScope`). Déterministe (lexique FR/EN
 * et motifs) ; rien ici n'est une preuve : une correspondance reste MATCHED ou UNCERTAIN, jamais
 * confirmée, et le parcours est un point d'entrée — les ressources transversales (intercepteurs,
 * gestionnaire d'erreurs) sont proposées au-delà de l'écran visible.
 */

export class AccessInputError extends Error {}

const STEP_ID = /^st_[a-z0-9]{4,24}$/;
/** Une valeur sensible écrite sous la forme « clé : valeur » (mot de passe, jeton, cookie, clé d'API). */
const SECRET_PAIR =
  /\b(mot de passe|mdp|password|passwd|pwd|token|jeton|secret|cookie|api[ _-]?key|cl[ée] d['’]api|bearer)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi;

/** Masque un texte saisi : règles du masqueur, puis les paires « clé : valeur » sensibles. */
export function maskAccessText(text: string): string {
  return redactText(text).replace(SECRET_PAIR, (_all, key: string, sep: string) => `${key}${sep}[masqué]`);
}

function field(raw: unknown, name: string, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new AccessInputError(`${name} must be a text`);
  const value = raw.trim();
  if (value.length > max) throw new AccessInputError(`${name} is limited to ${String(max)} characters`);
  return value === '' ? undefined : maskAccessText(value);
}

/** L'URL ou la route initiale : un chemin (« /dossiers ») ou une URL http(s), sans identifiants. */
function startUrl(raw: unknown): string | undefined {
  const value = field(raw, 'url', MAX_ACCESS_FIELD);
  if (value === undefined) return undefined;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AccessInputError('url must be a path starting with / or an http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AccessInputError('url must be a path starting with / or an http(s) URL');
  url.username = '';
  url.password = '';
  return redactText(url.toString());
}

const newStepId = (): string => `st_${randomBytes(6).toString('hex')}`;

/**
 * Valide et masque ce que la personne envoie ; `previous` garde ce qui n'est pas renvoyé (démonstration,
 * enregistrement, analyse). Lève AccessInputError (400) sur une saisie invalide.
 */
export function sanitizeAccess(
  raw: IncidentAccessInput,
  previous: IncidentAccess | undefined,
  actor: string,
  at: string,
): Omit<IncidentAccess, 'recording'> & { recording?: IncidentAccess['recording'] } {
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AccessInputError('body must be an object');
  const stepsRaw: unknown = raw.steps ?? previous?.steps ?? [];
  if (!Array.isArray(stepsRaw)) throw new AccessInputError('steps must be a list');
  if (stepsRaw.length > MAX_ACCESS_STEPS)
    throw new AccessInputError(`a scenario holds at most ${String(MAX_ACCESS_STEPS)} steps`);
  const steps: AccessStep[] = [];
  for (const [index, item] of stepsRaw.entries()) {
    if (typeof item !== 'object' || item === null)
      throw new AccessInputError(`steps[${String(index)}] is invalid`);
    const entry = item as { id?: unknown; text?: unknown };
    const text = field(entry.text, `steps[${String(index)}].text`, MAX_ACCESS_STEP);
    if (text === undefined) continue;
    const id = typeof entry.id === 'string' && STEP_ID.test(entry.id) ? entry.id : newStepId();
    steps.push({ id, text });
  }
  const pick = (key: keyof IncidentAccessInput, max: number): string | undefined =>
    key in raw ? field(raw[key], key, max) : (previous?.[key as keyof IncidentAccess] as string | undefined);
  const url = 'url' in raw ? startUrl(raw.url) : previous?.url;
  const start = pick('start', MAX_ACCESS_FIELD);
  const expected = pick('expected', MAX_ACCESS_FIELD);
  const observed = pick('observed', MAX_ACCESS_FIELD);
  const conditions = pick('conditions', MAX_ACCESS_FIELD);
  const testData = pick('testData', MAX_ACCESS_FIELD);
  const target = pick('target', MAX_ACCESS_FIELD);
  const hints = pick('hints', MAX_ACCESS_FIELD);
  const modeRaw: unknown = 'mode' in raw ? raw.mode : previous?.mode;
  if (modeRaw !== undefined && !(ACCESS_MODES as readonly unknown[]).includes(modeRaw))
    throw new AccessInputError(`mode must be one of ${ACCESS_MODES.join(', ')}`);
  const mode = modeRaw as IncidentAccess['mode'];
  const narrative =
    'narrative' in raw
      ? (field(raw.narrative, 'narrative', MAX_ACCESS_TEXT) ?? '')
      : (previous?.narrative ?? '');
  return {
    ...(start ? { start } : {}),
    ...(url ? { url } : {}),
    narrative,
    steps,
    ...(expected ? { expected } : {}),
    ...(observed ? { observed } : {}),
    ...(conditions ? { conditions } : {}),
    ...(testData ? { testData } : {}),
    ...(mode ? { mode } : {}),
    ...(target ? { target } : {}),
    ...(hints ? { hints } : {}),
    ...(previous?.recording ? { recording: previous.recording } : {}),
    ...(previous?.analysis ? { analysis: previous.analysis } : {}),
    ...(previous?.location ? { location: previous.location } : {}),
    ...(previous?.preparation ? { preparation: previous.preparation } : {}),
    ...(previous?.exploration ? { exploration: previous.exploration } : {}),
    updatedAt: at,
    updatedBy: actor,
  };
}

// ── Le parcours ───────────────────────────────────────────────────────────────────────────────

/** Un fragment qui décrit le symptôme (pas une étape) : il marque l'étape précédente comme critique. */
const SYMPTOM =
  /(bloqu|fig[ée]|freez|stuck|plant|crash|ne (r[ée]agi|r[ée]pond|fonctionne)|plus rien|rien ne se passe|nothing happens|ne se passe rien|cesse|stops?\s|stopped|unresponsive|erreur|error|exception|perd|perte|lost|ne part|n['’]est pas (envoy|enregistr))/i;
const AFTER_ACTION = /^(apr[èe]s (cette|cela|ça|quoi)|then the|after (that|this))/i;

const ACTIONS: [RegExp, AccessActionKind][] = [
  [/\b(me connecte|se connecter|connect|log ?in|logs? in|sign ?in|authentifi)/i, 'LOGIN'],
  [/\b(enregistr|sauvegard|save[sd]?\b|saving)/i, 'SAVE'],
  [/\b(valid|soum[ei]|submit|confirm)/i, 'SUBMIT'],
  [/\b(supprim|efface|delete|remove)/i, 'DELETE'],
  [/\b(cr[ée]{1,2}[res]*\b|cr[ée]ation|nouveau|nouvelle|create|new\b)/i, 'CREATE'],
  [/\b(modifi|[ée]dit|update|mets? à jour)/i, 'EDIT'],
  [/\b(rempli|saisi|tape|renseign|fill|type[sd]?\b|enter)/i, 'FILL'],
  [/\b(s[ée]lection|choisi|coch|select|choose|pick|check)/i, 'SELECT'],
  [/\b(recherch|cherch|search|look up)/i, 'SEARCH'],
  [/\b(cliqu|appui|press|click|tap)/i, 'CLICK'],
  [/\b(ferm|quitt|close)/i, 'CLOSE'],
  [/\b(attend|wait)/i, 'WAIT'],
  [/\b(ouvr|ouvre|acc[èe]d|affich|open|display)/i, 'OPEN'],
  [/\b(va (sur|dans|à)|vais (sur|dans|à)|aller|navigu|rends? sur|go to|goes to|navigate|visit)/i, 'NAVIGATE'],
];

const ELEMENTS: [RegExp, AccessElementKind][] = [
  [/\b(menu|sous-menu|submenu)\b/i, 'MENU'],
  [/\b(bouton|button|ic[ôo]ne|icon)\b/i, 'BUTTON'],
  [/\b(champs?|field|zone de saisie|input)\b/i, 'FIELD'],
  [/\b(onglet|tab)\b/i, 'TAB'],
  [/\b(page|[ée]cran|screen|vue|view)\b/i, 'PAGE'],
  [/\b(lien|link)\b/i, 'LINK'],
  [/\b(fen[êe]tre|modale?|modal|dialog|popup|pop-up)\b/i, 'MODAL'],
  [/\b(liste|list|tableau|table|grille|grid)\b/i, 'LIST'],
];

const QUOTED = /[«"“']\s*([^»"”']{2,60}?)\s*[»"”']/;
const AFTER_ELEMENT =
  /\b(?:menu|sous-menu|bouton|button|champs?|field|onglet|tab|page|[ée]cran|screen|lien|link|fen[êe]tre|modale?|modal|liste|list|formulaire|form)\s+(?:de |du |des |d['’]|«\s*)?([\p{L}\p{N}][\p{L}\p{N} '’-]{1,40})/iu;
const AFTER_ON = /\b(?:sur|on)\s+(?:le |la |les |l['’]|the )?([\p{L}\p{N}][\p{L}\p{N} '’-]{1,40})/iu;
const ENTITY =
  /\b(?:un|une|le|la|les|des|l['’]|a|an|the)\s+(?:nouveau|nouvelle|nouvel|new)?\s*([\p{L}][\p{L}-]{2,30})/iu;
/** Les mots qui ne désignent ni une zone ni une entité. */
const GENERIC = new Set(
  (
    'application appli menu bouton boutons button buttons champ champs field fields onglet page écran ecran screen lien link ' +
    'fenêtre fenetre modale modal liste list formulaire form action actions tout tous toutes chose choses clic click ' +
    'puis ensuite après apres avant quand lorsque nouveau nouvelle nouvel new données donnees data informations info ' +
    'utilisateur user système systeme plus rien bloque bloquée bloquee répondent repondent réagissent reagissent cette ce'
  ).split(' '),
);

/** Découpe en fragments : phrases, puis « , », « puis », « ensuite », « et je/on… ». */
function fragments(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .flatMap((sentence) =>
      sentence.split(
        /,\s*|\s+(?:puis|ensuite|et puis|then|and then)\s+|\s+(?:et|and)\s+(?=(?:j['’]|je |on |il |elle |i |we |clique|ouvr|cr[ée]|rempli|saisi|s[ée]lection|valid|enregistr|click|open|fill|save|select))/i,
      ),
    )
    .map((part) =>
      part
        .replace(/^[\s\-–•*\d.)]+/, '')
        .replace(/[.;!?]+$/, '')
        .trim(),
    )
    .filter((part) => part.length >= 3)
    .reduce<string[]>((list, part) => {
      // « Après cette action, l'application se bloque » : l'amorce reste avec son symptôme.
      const last = list.at(-1);
      if (
        last !== undefined &&
        /^(apr[èe]s (cette|cela|ça|quoi)\b[^,]{0,20}|then|after (that|this))$/i.test(last)
      )
        list[list.length - 1] = `${last}, ${part}`;
      else list.push(part);
      return list;
    }, []);
}

const clean = (value: string): string =>
  value
    .replace(/\s+(?:et|puis|then|and|pour|to|afin)\b.*$/i, '')
    .replace(/[«»"“”']/g, '')
    .trim();

function targetOf(fragment: string): string | undefined {
  const quoted = QUOTED.exec(fragment)?.[1];
  if (quoted) return quoted.trim();
  const afterElement = AFTER_ELEMENT.exec(fragment)?.[1];
  if (afterElement) return clean(afterElement);
  const afterOn = AFTER_ON.exec(fragment)?.[1];
  if (afterOn) return clean(afterOn);
  const entity = ENTITY.exec(fragment)?.[1];
  return entity ? clean(entity) : undefined;
}

function actionOf(fragment: string, target: string | undefined): AccessActionKind {
  const verb = ACTIONS.find(([pattern]) => pattern.test(fragment))?.[1] ?? 'OTHER';
  // « Cliquer sur Enregistrer » : l'action métier est l'enregistrement, pas le clic.
  if (verb === 'CLICK' && target) {
    const refined = ACTIONS.find(
      ([pattern, kind]) =>
        ['SAVE', 'SUBMIT', 'DELETE', 'CREATE', 'SEARCH', 'CLOSE'].includes(kind) && pattern.test(target),
    )?.[1];
    if (refined) return refined;
  }
  return verb;
}

function elementOf(fragment: string, action: AccessActionKind): AccessElementKind | undefined {
  const explicit = ELEMENTS.find(([pattern]) => pattern.test(fragment))?.[1];
  if (explicit) return explicit;
  if (action === 'FILL') return 'FIELD';
  if (['CLICK', 'SAVE', 'SUBMIT'].includes(action)) return 'BUTTON';
  return undefined;
}

export interface ParsedAccessPath {
  path: AccessPathStep[];
  /** Les fragments qui décrivent le symptôme (« l'application se bloque »). */
  symptoms: string[];
}

/**
 * Le parcours d'un texte libre et d'étapes numérotées : une étape par fragment d'action, le symptôme
 * mis à part et l'étape qui le précède marquée critique. Les étapes d'un enregistrement s'ajoutent telles
 * quelles (déjà décrites par le module Enregistrements, sans valeur saisie).
 */
export function parseAccessPath(input: {
  narrative?: string;
  steps?: readonly { text: string }[];
  recording?: readonly { description: string; kind?: string }[];
}): ParsedAccessPath {
  const path: AccessPathStep[] = [];
  const symptoms: string[] = [];
  const push = (text: string, source: AccessPathStep['source']): void => {
    if (SYMPTOM.test(text) || AFTER_ACTION.test(text)) {
      symptoms.push(text);
      const previous = [...path].reverse().find((step) => step.source === source);
      if (previous) previous.critical = true;
      return;
    }
    const target = targetOf(text);
    const action = actionOf(text, target);
    const element = elementOf(text, action);
    path.push({
      index: path.length + 1,
      text,
      source,
      action,
      ...(target ? { target } : {}),
      ...(element ? { element } : {}),
      critical: false,
    });
  };
  for (const step of input.steps ?? []) for (const part of fragments(step.text)) push(part, 'STEPS');
  // Le texte libre complète les étapes : ses fragments déjà présents ne sont pas répétés.
  const seen = new Set(path.map((step) => step.text.toLowerCase()));
  for (const part of fragments(input.narrative ?? '')) if (!seen.has(part.toLowerCase())) push(part, 'TEXT');
  for (const step of input.recording ?? []) {
    const target = targetOf(step.description);
    const action = actionOf(step.description, target);
    const element = elementOf(step.description, action);
    path.push({
      index: path.length + 1,
      text: step.description,
      source: 'RECORDING',
      action,
      ...(target ? { target } : {}),
      ...(element ? { element } : {}),
      critical: false,
    });
  }
  // Sans symptôme placé, la dernière action d'enregistrement ou de validation est l'événement probable.
  if (!path.some((step) => step.critical)) {
    const last = [...path].reverse().find((step) => step.action === 'SAVE' || step.action === 'SUBMIT');
    if (last && symptoms.length > 0) last.critical = true;
  }
  return { path: path.slice(0, 80), symptoms };
}

/** Le singulier simple d'un mot français ou anglais (« dossiers » → « dossier »). */
const singular = (word: string): string => (word.length > 4 && /[sx]$/.test(word) ? word.slice(0, -1) : word);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !GENERIC.has(word));

/** Les interprétations du parcours (zones, entités, action critique), chacune avec sa confiance et sa source. */
export function interpretations(
  parsed: ParsedAccessPath,
  brief: Pick<IncidentBrief, 'functionalArea' | 'businessAction'>,
  application?: string,
): AccessInterpretation[] {
  const out: AccessInterpretation[] = [];
  const add = (entry: AccessInterpretation): void => {
    const existing = out.find(
      (item) => item.kind === entry.kind && item.value.toLowerCase() === entry.value.toLowerCase(),
    );
    if (existing) existing.confidence = Math.max(existing.confidence, entry.confidence);
    else out.push(entry);
  };
  for (const step of parsed.path) {
    if (!step.target || GENERIC.has(step.target.toLowerCase())) continue;
    if ((step.action === 'OPEN' || step.action === 'NAVIGATE') && step.element !== 'FIELD')
      add({
        kind: 'AREA',
        value: step.target,
        confidence: step.element === 'MENU' || step.element === 'PAGE' || step.element === 'TAB' ? 0.8 : 0.6,
        from: step.text,
      });
    if (step.action === 'CREATE' || step.action === 'EDIT' || step.action === 'DELETE')
      add({ kind: 'ENTITY', value: singular(step.target.toLowerCase()), confidence: 0.6, from: step.text });
    if (step.critical) {
      add({ kind: 'TRIGGER', value: step.target, confidence: 0.75, from: step.text });
      add({ kind: 'ACTION', value: step.action, confidence: 0.7, from: step.text });
    }
  }
  if (brief.functionalArea)
    add({ kind: 'AREA', value: brief.functionalArea.text, confidence: 0.65, from: 'description' });
  if (brief.businessAction)
    add({ kind: 'TRIGGER', value: brief.businessAction.text, confidence: 0.6, from: 'description' });
  for (const entity of out.filter((item) => item.kind === 'ENTITY'))
    if (!out.some((item) => item.kind === 'AREA' && item.value.toLowerCase().startsWith(entity.value)))
      add({ kind: 'AREA', value: entity.value, confidence: 0.5, from: entity.from });
  if (application)
    add({ kind: 'AREA', value: application, confidence: 0.45, from: 'application de l’incident' });
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, 16);
}

/** Les mots-clés de la découverte : ceux du parcours d'abord (zones, entités, cibles), puis ceux du texte. */
export function accessKeywords(
  parsed: ParsedAccessPath,
  found: readonly AccessInterpretation[],
  brief: readonly string[],
): string[] {
  const ordered = [
    ...found.filter((item) => item.kind !== 'ACTION').flatMap((item) => words(item.value)),
    ...parsed.path.flatMap((step) => (step.target ? words(step.target) : [])),
    ...brief.filter((word) => !GENERIC.has(word)),
  ].map(singular);
  return [...new Set(ordered)].slice(0, 12);
}

// ── Les portions de code ───────────────────────────────────────────────────────────────────────

/** Les défaillances qui évoquent un blocage global ou une erreur silencieuse : elles ouvrent les pistes transversales. */
const GLOBAL_FAILURES: readonly SilentFailureKind[] = [
  'GLOBAL_ACTION_FAILURE',
  'UI_STATE_STUCK',
  'NO_FUNCTIONAL_REACTION_AFTER_ACTION',
  'EVENT_HANDLER_EXCEPTION',
  'UNHANDLED_PROMISE_REJECTION',
  'HTTP_REQUEST_NOT_EMITTED',
  'VALIDATION_NOT_EXECUTED',
  'FORM_SUBMISSION_NOT_TRIGGERED',
];

const ref = (node: { file: string; line: number }): string => `${node.file}:${String(node.line)}`;

/** Les candidats : les ressources découvertes (hors dépôts autorisés), puis les ressources transversales. */
export function accessCandidates(graph: ScopeGraph, angular: readonly AngularModel[]): AccessCandidate[] {
  const out: AccessCandidate[] = [];
  for (const resource of graph.resources) {
    if (resource.kind === 'REPOSITORY' && resource.status === 'AUTHORIZED') continue;
    const textual = resource.foundBy.some((by) => by === 'TEXT' || by === 'NAVIGATION' || by === 'NETWORK');
    out.push({
      id: resource.id,
      kind: resource.kind,
      label: resource.label,
      ref: resource.ref,
      ...(resource.applicationId ? { applicationId: resource.applicationId } : {}),
      confidence: Math.round(resource.relevance * 100) / 100,
      match: textual && resource.relevance >= 0.25 ? 'MATCHED' : 'UNCERTAIN',
      status: resource.status,
      reasons: [resource.reason, resource.detail].filter((item): item is string => Boolean(item)),
    });
  }
  const transversalKinds: Partial<Record<AngularNodeKind, string>> = {
    INTERCEPTOR: 'intercepteur HTTP : traverse toutes les requêtes, au-delà de l’écran du parcours',
    ERROR_HANDLER: 'gestionnaire d’erreurs global : reçoit les exceptions de toute l’application',
  };
  for (const model of angular)
    for (const node of model.nodes) {
      const why = transversalKinds[node.kind];
      if (!why || out.some((item) => item.id === node.id)) continue;
      out.push({
        id: node.id,
        kind: 'SERVICE',
        label: node.name,
        ref: ref(node),
        applicationId: model.applicationId,
        confidence: 0.3,
        match: 'UNCERTAIN',
        status: 'AUTHORIZED',
        reasons: [why],
        transversal: true,
      });
    }
  const order = (item: AccessCandidate): number => (item.match === 'MATCHED' ? 0 : item.transversal ? 2 : 1);
  return out.sort((a, b) => order(a) - order(b) || b.confidence - a.confidence).slice(0, 40);
}

/**
 * Les pistes d'un blocage global ou d'une erreur silencieuse (quand le texte en décrit une) : chaque
 * piste cite les emplacements du code lu qui la portent, jamais une cause. Rien n'est conclu ici.
 */
export function accessLeads(
  anomalies: readonly SilentFailureKind[],
  dataLoss: boolean,
  angular: readonly AngularModel[],
  candidates: readonly AccessCandidate[],
  lang: 'fr' | 'en' = 'fr',
): AccessLead[] {
  if (!dataLoss && !anomalies.some((kind) => GLOBAL_FAILURES.includes(kind))) return [];
  const nodes = angular.flatMap((model) => model.nodes);
  const files = new Set(candidates.map((item) => item.ref.split(':')[0]));
  const refsOf = (kinds: readonly AngularNodeKind[], near = false): string[] =>
    nodes
      .filter((node) => kinds.includes(node.kind) && (!near || files.has(node.file)))
      .slice(0, 6)
      .map(ref);
  const fr = lang === 'fr';
  const leads: AccessLead[] = [
    {
      kind: 'HANDLER',
      label: fr ? 'Gestionnaires des actions du parcours' : 'Handlers of the path actions',
      why: fr
        ? 'Une exception ou une promesse non résolue dans le gestionnaire de l’action critique peut interrompre les réactions suivantes.'
        : 'An exception or an unresolved promise in the critical action handler can stop the next reactions.',
      refs: refsOf(['HANDLER'], true),
    },
    {
      kind: 'ERROR_HANDLER',
      label: fr ? 'Gestionnaire d’erreurs global' : 'Global error handler',
      why: fr
        ? 'Une erreur avalée sans retour à un état cohérent laisse l’écran affiché mais inerte.'
        : 'A swallowed error that does not restore a consistent state leaves the screen visible but inert.',
      refs: refsOf(['ERROR_HANDLER']),
    },
    {
      kind: 'STREAM',
      label: fr ? 'Flux RxJS, signaux et abonnements' : 'RxJS streams, signals and subscriptions',
      why: fr
        ? 'Un flux terminé par une erreur cesse d’émettre : validations, chargements et requêtes ne se déclenchent plus.'
        : 'A stream completed by an error stops emitting: validations, loaders and requests no longer fire.',
      refs: refsOf(['STREAM', 'SIGNAL'], true)
        .concat(refsOf(['STREAM', 'SIGNAL']))
        .slice(0, 6),
    },
    {
      kind: 'INTERCEPTOR',
      label: fr ? 'Intercepteurs HTTP' : 'HTTP interceptors',
      why: fr
        ? 'Une requête attendue qui ne part pas peut être retenue ou transformée par un intercepteur.'
        : 'An expected request that is never sent can be held or rewritten by an interceptor.',
      refs: refsOf(['INTERCEPTOR']),
    },
    {
      kind: 'HTTP',
      label: fr ? 'Appels HTTP des composants candidats' : 'HTTP calls of the candidate components',
      why: fr
        ? 'À vérifier pendant la reproduction : la requête de l’action critique part-elle, et revient-elle ?'
        : 'To check during reproduction: is the critical action request sent, and does it return?',
      refs: refsOf(['HTTP_CALL'], true),
    },
    {
      kind: 'LIFECYCLE',
      label: fr ? 'Cycle de vie et modales' : 'Lifecycle and modals',
      why: fr
        ? 'Ouvrir puis fermer un composant (modale, panneau) peut laisser un abonnement ou un état partagé incohérent.'
        : 'Opening then closing a component (modal, panel) can leave a subscription or shared state inconsistent.',
      refs: refsOf(['LIFECYCLE']),
    },
    {
      kind: 'CHANGE_DETECTION',
      label: fr ? 'Détection des changements et Zone.js' : 'Change detection and Zone.js',
      why: fr
        ? 'L’écran qui se met encore à jour partiellement alors que les événements ne sont plus traités est à observer en reproduction (erreurs console, traitements longs).'
        : 'A screen still partly updating while events are no longer handled is to be observed during reproduction (console errors, long tasks).',
      refs: [],
    },
  ];
  if (dataLoss)
    leads.push({
      kind: 'STATE',
      label: fr ? 'État en mémoire perdu au rechargement' : 'In-memory state lost on reload',
      why: fr
        ? 'La perte des données non enregistrées après un rechargement suit le blocage : la cause à chercher est ce qui empêche l’enregistrement.'
        : 'Losing unsaved data after a reload follows the freeze: the cause to look for is what prevents saving.',
      refs: [],
    });
  return leads;
}

export interface AccessAnalysisInput {
  access: IncidentAccess;
  brief: IncidentBrief;
  parsed: ParsedAccessPath;
  found: AccessInterpretation[];
  keywords: string[];
  graph: ScopeGraph | undefined;
  angular: readonly AngularModel[];
  limits: string[];
  recordingUsed: boolean;
  actor: string;
  at: string;
  lang?: 'fr' | 'en';
}

/** Assemble le résultat de l'analyse (rien n'est lu ici : tout vient des étapes précédentes). */
export function buildAccessAnalysis(input: AccessAnalysisInput): AccessAnalysis {
  const { access, brief, parsed } = input;
  const candidates = input.graph ? accessCandidates(input.graph, input.angular) : [];
  const elements = parsed.path
    .filter((step): step is AccessPathStep & { element: AccessElementKind; target: string } =>
      Boolean(step.element && step.target),
    )
    .map((step) => ({ kind: step.element, label: step.target }))
    .filter(
      (item, index, list) =>
        list.findIndex((other) => other.kind === item.kind && other.label === item.label) === index,
    )
    .slice(0, 30);
  const sources: AccessAnalysis['sources'] = [];
  if (access.narrative.trim()) sources.push('TEXT');
  if (access.steps.length > 0) sources.push('STEPS');
  if (input.recordingUsed) sources.push('RECORDING');
  return {
    analyzedAt: input.at,
    analyzedBy: input.actor,
    sources,
    path: parsed.path,
    interpretations: input.found,
    elements,
    anomalies: brief.suspectedFailures,
    conditions: [
      ...(access.conditions ? [access.conditions] : []),
      ...brief.knownConditions.map((item) => item.text),
      ...brief.unknownConditions.map((item) => item.text),
    ].slice(0, 10),
    keywords: input.keywords,
    candidates,
    leads: accessLeads(
      brief.suspectedFailures,
      Boolean(brief.dataLoss),
      input.angular,
      candidates,
      input.lang,
    ),
    limits: input.limits,
  };
}

/** Le texte du parcours pour l'interprète (et la découverte du déclencheur) : tout ce que la personne a écrit. */
export function accessText(
  access: IncidentAccess,
  recording: readonly { description: string }[] = [],
): string {
  return [
    access.target ? `Écran cible : ${access.target}` : '',
    access.hints ? `Indications : ${access.hints}` : '',
    access.start ? `Départ : ${access.start}` : '',
    access.narrative,
    ...access.steps.map((step, index) => `${String(index + 1)}. ${step.text}`),
    ...recording.map((step) => step.description),
    access.observed ?? '',
    access.expected ? `Attendu : ${access.expected}` : '',
    access.conditions ?? '',
  ]
    .filter((line) => line.trim() !== '')
    .join('\n')
    .slice(0, MAX_ACCESS_TEXT * 2);
}
