import type {
  CodeLayer,
  DiscoveredApplication,
  Incident,
  InvestigationScope,
  KnownRepository,
  ScopeApplication,
  ScopeDiscovery,
} from '../core/incident-contracts.js';
import { icon } from './dashboard-parts.js';
import type { Lang } from './incident-parts.js';
import type { ScopeContext } from './incident-scope.js';
import { esc } from './view.js';

/**
 * LE BLOC « APPLICATIONS ET DÉPÔTS » DE L'ÉTAPE PÉRIMÈTRE : un chemin de projet (ou un dépôt déjà connu de
 * l'environnement), un bouton « Analyser automatiquement », les applications détectées par le serveur
 * (cadres, couche, modules, points d'entrée, configurations, relations, preuves), cochées quand elles sont
 * proposées pour l'incident ; la couche se corrige d'un choix quand la découverte n'a pu que la déduire.
 * « Ajouter au périmètre » enregistre les applications cochées (brouillon ou périmètre défini) ou, une fois
 * l'investigation commencée, demande des extensions du périmètre (ADD_APPLICATION, à décider). Des fonctions
 * pures : le contrôleur des incidents tient l'état, appelle `incidents.discoverScope`, `incidents.knownRepositories`,
 * `incidents.update` et `incidents.requestExtension`. Rien n'est inventé : tout vient du serveur ou de la saisie.
 */

// ── État ─────────────────────────────────────────────────────────────────────────────────────

export interface DiscoveryUi {
  /** L'incident du brouillon (un autre incident repart de zéro). */
  incidentId?: string;
  /** Le chemin saisi. */
  root: string;
  /** Les dépôts connus (lus une fois par incident) ; `knownState` pendant la lecture ou après un refus. */
  known?: KnownRepository[];
  knownState?: 'loading' | 'denied' | { error: string };
  result?: ScopeDiscovery;
  /** Les applications cochées (par identifiant détecté) et les couches corrigées. */
  selected: Record<string, boolean>;
  layers: Record<string, CodeLayer>;
  /** La section avancée (saisie manuelle) dépliée. */
  advanced: boolean;
}

export const emptyDiscoveryUi = (incidentId?: string): DiscoveryUi => ({
  ...(incidentId ? { incidentId } : {}),
  root: '',
  selected: {},
  layers: {},
  advanced: false,
});

const LAYERS: readonly CodeLayer[] = ['FRONTEND', 'BFF', 'BACKEND'];
const isLayer = (value: string | undefined): value is CodeLayer =>
  (LAYERS as readonly string[]).includes(value ?? '');

/** Un résultat reçu : les applications proposées sont cochées, les couches repartent de celles détectées. */
export function withResult(ui: DiscoveryUi, result: ScopeDiscovery): DiscoveryUi {
  const selected: Record<string, boolean> = {};
  for (const entry of result.applications) selected[entry.application.id] = entry.suggested;
  return { ...ui, result, selected, layers: {} };
}

export function withKnown(ui: DiscoveryUi, known: KnownRepository[]): DiscoveryUi {
  const next = { ...ui, known };
  delete next.knownState;
  return next;
}

/**
 * Le réducteur pur des actions du bloc (préfixe `inc-disc-`) : `inc-disc-root` (`value`), `inc-disc-known`
 * (`root` : un dépôt connu choisi), `inc-disc-toggle` (`block` : l'application), `inc-disc-layer` (`block`,
 * `value`), `inc-disc-clear` (le résultat oublié), `inc-disc-advanced` (`open` : l'état affiché). Undefined :
 * action d'un autre bloc.
 */
export function reduceDiscovery(
  ui: DiscoveryUi,
  action: string,
  dataset: Record<string, string | undefined>,
): DiscoveryUi | undefined {
  switch (action) {
    case 'inc-disc-root':
      return { ...ui, root: dataset.value ?? '' };
    case 'inc-disc-known':
      return dataset.root ? { ...ui, root: dataset.root } : ui;
    case 'inc-disc-toggle': {
      const id = dataset.block;
      const entry = ui.result?.applications.find((item) => item.application.id === id);
      if (!id || !entry || entry.alreadyInScope !== undefined) return ui;
      return { ...ui, selected: { ...ui.selected, [id]: !(ui.selected[id] ?? false) } };
    }
    case 'inc-disc-layer': {
      const id = dataset.block;
      if (!id || !isLayer(dataset.value)) return ui;
      return { ...ui, layers: { ...ui.layers, [id]: dataset.value } };
    }
    case 'inc-disc-clear': {
      const next = { ...ui, selected: {}, layers: {} };
      delete next.result;
      return next;
    }
    case 'inc-disc-advanced':
      return { ...ui, advanced: dataset.open !== 'true' };
    default:
      return undefined;
  }
}

/** La couche affichée d'une application détectée : la correction, sinon celle déduite. */
export const layerOf = (ui: DiscoveryUi, entry: DiscoveredApplication): CodeLayer =>
  ui.layers[entry.application.id] ?? entry.application.layer;

/** Les applications cochées, prêtes pour le périmètre (couche corrigée), hors celles déjà dans le périmètre. */
export function selectedApplications(ui: DiscoveryUi): ScopeApplication[] {
  return (ui.result?.applications ?? [])
    .filter((entry) => entry.alreadyInScope === undefined && ui.selected[entry.application.id] === true)
    .map((entry) => ({ ...entry.application, layer: layerOf(ui, entry) }));
}

export type ApplyPlan =
  | { kind: 'NONE' }
  | { kind: 'UPDATE'; scope: InvestigationScope; added: ScopeApplication[] }
  | {
      kind: 'EXTENSIONS';
      requests: { kind: 'ADD_APPLICATION'; target: string; applicationId: string; reason: string }[];
    };

/** Un périmètre pas encore investigué se modifie directement ; ensuite, chaque application est une extension à décider. */
const directlyEditable = (state: Incident['state']): boolean => state === 'DRAFT' || state === 'SCOPED';

/**
 * Ce que « Ajouter au périmètre » fait : en brouillon ou périmètre défini, le périmètre complété (identifiants
 * uniques, permissions et limites inchangées) ; investigation commencée, une demande d'extension
 * ADD_APPLICATION par application (cible « COUCHE:racine », motivée par les preuves de la découverte).
 */
export function applyPlan(incident: Incident, ui: DiscoveryUi): ApplyPlan {
  const added = selectedApplications(ui);
  if (added.length === 0 || !ui.result) return { kind: 'NONE' };
  const taken = new Set(incident.scope.applications.map((application) => application.id));
  const unique = added.map((application) => {
    let id = application.id;
    for (let n = 2; taken.has(id); n += 1) id = `${application.id}-${n}`;
    taken.add(id);
    return { ...application, id };
  });
  if (directlyEditable(incident.state))
    return {
      kind: 'UPDATE',
      scope: { ...incident.scope, applications: [...incident.scope.applications, ...unique] },
      added: unique,
    };
  const root = ui.result.root;
  return {
    kind: 'EXTENSIONS',
    requests: unique.map((application) => ({
      kind: 'ADD_APPLICATION',
      target: `${application.layer}:${application.repository.root}`,
      applicationId: application.id,
      reason: `Découverte automatique de « ${root} » : ${(application.origin?.evidence ?? []).slice(0, 3).join(' ; ') || application.name}`,
    })),
  };
}

// ── Textes ───────────────────────────────────────────────────────────────────────────────────

const fr = {
  title: 'Applications et dépôts',
  sub: 'Indiquez le chemin du projet : la découverte détecte les applications, leurs cadres, leurs modules et leurs relations. Vous ne choisissez que ce qui ne peut pas être déduit.',
  root: 'Chemin du projet',
  rootHint:
    'Chemin absolu sur la machine qui investigue (pas votre poste). Lecture seule, contrôlée par le périmètre : fichiers sensibles refusés, rien n’est écrit.',
  placeholder: '/srv/repos/catalogue',
  analyze: 'Analyser automatiquement',
  analyzing: 'Analyse en cours…',
  known: 'Dépôts connus de l’environnement :',
  knownLoading: 'Lecture des dépôts connus…',
  knownNone: 'Aucun dépôt connu pour l’instant : indiquez un chemin.',
  knownDenied: 'Votre rôle ne permet pas de parcourir les dépôts.',
  knownError: (message: string) => `Dépôts connus illisibles : ${message}`,
  knownUse: (label: string, root: string) => `Analyser ${label} (${root})`,
  sources: { PROJECT: 'projet', SCOPE: 'périmètre', INCIDENT: 'autre incident' } as Record<
    KnownRepository['source'],
    string
  >,
  structures: {
    SINGLE: 'Une application',
    MONOREPO: 'Monorepo',
    MULTI_APP: 'Plusieurs applications',
    UNKNOWN: 'Structure non reconnue',
  } as Record<ScopeDiscovery['structure'], string>,
  summary: (detected: number, suggested: number) =>
    `${String(detected)} application(s) détectée(s), ${String(suggested)} proposée(s) pour cet incident`,
  tools: (tools: string) => `Outils : ${tools}`,
  keywords: (words: string) => `Mots de l’incident retenus : ${words}`,
  noKeywords:
    'Aucun mot exploitable dans la description : toutes les applications détectées sont proposées (trois au plus).',
  problems: 'Points à corriger',
  layers: { FRONTEND: 'Frontend', BFF: 'BFF', BACKEND: 'Backend' } as Record<CodeLayer, string>,
  layerFor: (name: string) => `Couche de ${name}`,
  confidence: { HIGH: 'détection sûre', MEDIUM: 'détection probable', LOW: 'détection incertaine' } as Record<
    DiscoveredApplication['confidence'],
    string
  >,
  alreadyInScope: (id: string) => `déjà dans le périmètre (${id})`,
  wholeRoot: 'racine du dépôt',
  frameworks: 'Cadres',
  languages: 'Langages',
  modules: (count: number) => `Modules (${String(count)})`,
  modulesNone: 'Aucun module repéré.',
  matched: (words: string) => `touche : ${words}`,
  entryPoints: 'Points d’entrée',
  configs: 'Configurations',
  services: 'Services et dépendances',
  evidence: 'Preuves',
  questions: 'À confirmer',
  details: 'Détails de la détection',
  relations: (count: number) => `Relations entre applications (${String(count)})`,
  relationKinds: { CALLS: 'appelle', USES: 'utilise' } as Record<string, string>,
  relationStatus: { STATICALLY_RESOLVED: 'déclaré', INFERRED: 'déduit' } as Record<string, string>,
  denied: (count: number) => `Refus de lecture (${String(count)})`,
  truncated: 'Lecture partielle',
  read: (count: number) => `Fichiers lus (${String(count)})`,
  apply: (count: number) => `Ajouter ${String(count)} application(s) au périmètre`,
  applyExtensions: (count: number) => `Demander l’extension du périmètre (${String(count)})`,
  applyNone: 'Cochez au moins une application.',
  applyHint:
    'Le périmètre initial n’est pas une limite : pendant l’investigation, il s’étend par extension approuvée, et chaque découverte reste tracée.',
  applyExtensionsHint:
    'L’investigation a commencé : chaque application est une demande d’extension du périmètre, à approuver (droit de décision).',
  clear: 'Effacer le résultat',
  advanced: 'Paramètres avancés (saisie manuelle)',
  readOnly: 'Lecture seule : votre rôle ne permet pas d’analyser un dépôt.',
  demo: 'Découverte indisponible en démonstration.',
  locked: 'Le périmètre ne change pas pendant une reproduction ni après une annulation.',
  failed: 'Analyse impossible',
  partial: 'Analyse partielle',
};

const en: typeof fr = {
  title: 'Applications and repositories',
  sub: 'Give the project path: the discovery detects the applications, their frameworks, modules and relations. You only choose what cannot be inferred.',
  root: 'Project path',
  rootHint:
    'Absolute path on the investigating machine (not your workstation). Read only, under the scope policy: sensitive files refused, nothing written.',
  placeholder: '/srv/repos/catalogue',
  analyze: 'Analyze automatically',
  analyzing: 'Analyzing…',
  known: 'Repositories known to the environment:',
  knownLoading: 'Reading the known repositories…',
  knownNone: 'No known repository yet: type a path.',
  knownDenied: 'Your role does not allow browsing the repositories.',
  knownError: (message) => `Known repositories unreadable: ${message}`,
  knownUse: (label, root) => `Analyze ${label} (${root})`,
  sources: { PROJECT: 'project', SCOPE: 'scope', INCIDENT: 'other incident' },
  structures: {
    SINGLE: 'One application',
    MONOREPO: 'Monorepo',
    MULTI_APP: 'Several applications',
    UNKNOWN: 'Unrecognized structure',
  },
  summary: (detected, suggested) =>
    `${String(detected)} application(s) detected, ${String(suggested)} suggested for this incident`,
  tools: (tools) => `Tools: ${tools}`,
  keywords: (words) => `Incident words used: ${words}`,
  noKeywords: 'No usable word in the description: every detected application is suggested (three at most).',
  problems: 'Things to fix',
  layers: { FRONTEND: 'Frontend', BFF: 'BFF', BACKEND: 'Backend' },
  layerFor: (name) => `Layer of ${name}`,
  confidence: { HIGH: 'reliable detection', MEDIUM: 'probable detection', LOW: 'uncertain detection' },
  alreadyInScope: (id) => `already in the scope (${id})`,
  wholeRoot: 'repository root',
  frameworks: 'Frameworks',
  languages: 'Languages',
  modules: (count) => `Modules (${String(count)})`,
  modulesNone: 'No module found.',
  matched: (words) => `matches: ${words}`,
  entryPoints: 'Entry points',
  configs: 'Configurations',
  services: 'Services and dependencies',
  evidence: 'Evidence',
  questions: 'To confirm',
  details: 'Detection details',
  relations: (count) => `Relations between applications (${String(count)})`,
  relationKinds: { CALLS: 'calls', USES: 'uses' },
  relationStatus: { STATICALLY_RESOLVED: 'declared', INFERRED: 'inferred' },
  denied: (count) => `Read refusals (${String(count)})`,
  truncated: 'Partial read',
  read: (count) => `Files read (${String(count)})`,
  apply: (count) => `Add ${String(count)} application(s) to the scope`,
  applyExtensions: (count) => `Request the scope extension (${String(count)})`,
  applyNone: 'Check at least one application.',
  applyHint:
    'The initial scope is not a limit: during the investigation it grows through approved extensions, and every discovery stays traced.',
  applyExtensionsHint:
    'The investigation has started: each application is a scope extension request, to approve (decision right).',
  clear: 'Clear the result',
  advanced: 'Advanced settings (manual entry)',
  readOnly: 'Read only: your role does not allow analyzing a repository.',
  demo: 'Discovery unavailable in the demonstration.',
  locked: 'The scope does not change during a reproduction nor after a cancellation.',
  failed: 'Analysis impossible',
  partial: 'Partial analysis',
};

const TEXT: Record<Lang, typeof fr> = { fr, en };
export const discoveryText = (lang: Lang): typeof fr => TEXT[lang];

// ── Rendu ────────────────────────────────────────────────────────────────────────────────────

const pill = (text: string, extra = ''): string =>
  `<span class="inc-sd-pill${extra ? ` ${extra}` : ''}">${esc(text)}</span>`;
const codes = (items: readonly string[]): string =>
  items.map((item) => `<code>${esc(item)}</code>`).join(' ');

/** Le bloc peut-il lancer une analyse et modifier le périmètre (droit RUN, ni démonstration, ni reproduction en cours, ni annulation) ? */
export const discoveryEditable = (ctx: ScopeContext): boolean =>
  ctx.can('RUN') && !ctx.demo && ctx.incident.state !== 'CANCELLED' && ctx.incident.state !== 'REPRODUCING';

function knownBlock(ctx: ScopeContext, ui: DiscoveryUi, disabled: boolean): string {
  const t = TEXT[ctx.lang];
  if (ui.knownState === 'loading')
    return `<p class="mu inc-sd-known" aria-busy="true"><span class="spin sm" aria-hidden="true"></span> ${esc(t.knownLoading)}</p>`;
  if (ui.knownState === 'denied') return `<p class="mu inc-sd-known">${esc(t.knownDenied)}</p>`;
  if (ui.knownState && typeof ui.knownState === 'object')
    return `<p class="mu inc-sd-known">${esc(t.knownError(ui.knownState.error))}</p>`;
  if (!ui.known) return '';
  if (ui.known.length === 0) return `<p class="mu inc-sd-known">${esc(t.knownNone)}</p>`;
  return `<div class="inc-sd-known"><span class="mu">${esc(t.known)}</span><ul class="inc-sd-chips" role="list">${ui.known
    .map(
      (repo) =>
        `<li><button type="button" class="inc-sd-chip" data-action="inc-disc-known" data-root="${esc(repo.root)}" title="${esc(t.knownUse(repo.label, repo.root))}" aria-label="${esc(t.knownUse(repo.label, repo.root))}"${disabled ? ' disabled' : ''}>${icon('projects')}<span class="inc-sd-chip-l">${esc(repo.label)}</span><code>${esc(repo.root)}</code><small class="mu">${esc(t.sources[repo.source])}</small></button></li>`,
    )
    .join('')}</ul></div>`;
}

function applicationCard(
  ctx: ScopeContext,
  ui: DiscoveryUi,
  entry: DiscoveredApplication,
  disabled: boolean,
): string {
  const t = TEXT[ctx.lang];
  const id = entry.application.id;
  const inScope = entry.alreadyInScope !== undefined;
  const checked = inScope || ui.selected[id] === true;
  const layer = layerOf(ui, entry);
  const location = entry.path === '' ? t.wholeRoot : `${entry.path}/`;
  const layerSelect = `<label class="inc-sd-layer"><span class="sr">${esc(t.layerFor(entry.application.name))}</span><select data-inc="disc.layer.${esc(id)}" class="inc-sd-l-${layer.toLowerCase()}"${disabled || inScope ? ' disabled' : ''}>${LAYERS.map(
    (option) =>
      `<option value="${option}"${option === layer ? ' selected' : ''}>${esc(t.layers[option])}</option>`,
  ).join('')}</select></label>`;
  const modules =
    entry.modules.length === 0
      ? `<p class="mu">${esc(t.modulesNone)}</p>`
      : `<ul class="inc-sd-mods" role="list">${entry.modules
          .map(
            (module) =>
              `<li${module.matched?.length ? ' class="hit"' : ''}><code title="${esc(module.path)}">${esc(module.name)}/</code>${module.matched?.length ? `<small>${esc(t.matched(module.matched.join(', ')))}</small>` : ''}</li>`,
          )
          .join('')}</ul>`;
  const row = (label: string, body: string): string =>
    body ? `<div class="inc-sd-row"><dt>${esc(label)}</dt><dd>${body}</dd></div>` : '';
  const details = `<details class="inc-sd-det"><summary>${esc(t.details)}</summary><dl class="inc-sd-dl">${row(t.modules(entry.modules.length), modules)}${row(t.entryPoints, codes(entry.entryPoints))}${row(t.configs, codes(entry.configs))}${row(t.services, entry.services.map((service) => pill(service)).join(''))}${row(
    t.evidence,
    entry.evidence.length > 0
      ? `<ul class="plain inc-sd-ev">${entry.evidence.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
      : '',
  )}</dl></details>`;
  const questions =
    entry.questions.length > 0
      ? `<ul class="inc-sd-q" role="list">${entry.questions.map((question) => `<li>${icon('alert')}<span>${esc(question)}</span></li>`).join('')}</ul>`
      : '';
  const reasons =
    entry.reasons.length > 0 ? `<p class="mu inc-sd-why">${esc(entry.reasons.join(' · '))}</p>` : '';
  return `<li class="inc-sd-app${checked ? ' on' : ''}${inScope ? ' known' : ''}" data-app="${esc(id)}"><div class="inc-sd-app-h"><label class="inc-sd-check"><input type="checkbox" data-inc="disc.app.${esc(id)}" data-block="${esc(id)}"${checked ? ' checked' : ''}${disabled || inScope ? ' disabled' : ''}><b>${esc(entry.application.name)}</b><code title="${esc(entry.application.repository.root)}">${esc(location)}</code></label>${layerSelect}${entry.frameworks.map((framework) => pill(framework, 'fw')).join('')}${entry.languages.map((language) => pill(language)).join('')}${pill(t.confidence[entry.confidence], `conf-${entry.confidence.toLowerCase()}`)}${inScope ? pill(t.alreadyInScope(entry.alreadyInScope ?? ''), 'in') : ''}</div>${reasons}${questions}${details}</li>`;
}

function resultBlock(
  ctx: ScopeContext,
  ui: DiscoveryUi,
  result: ScopeDiscovery,
  disabled: boolean,
  busy: boolean,
): string {
  const t = TEXT[ctx.lang];
  const problems =
    result.problems.length > 0
      ? `<div class="inc-sd-problems" role="${result.status === 'FAILED' ? 'alert' : 'status'}"><p class="${result.status === 'FAILED' ? 'err' : 'mu'}"><b>${esc(result.status === 'FAILED' ? t.failed : t.partial)}</b></p><ul class="plain">${result.problems
          .map(
            (problem) =>
              `<li>${icon(result.status === 'FAILED' ? 'cross' : 'alert')}<span><b>${esc(problem.message)}</b> ${esc(problem.hint)}</span></li>`,
          )
          .join('')}</ul></div>`
      : '';
  if (result.applications.length === 0) return `<div class="inc-sd-res">${problems}</div>`;
  const suggested = result.applications.filter((entry) => entry.suggested).length;
  const summary = `<p class="inc-sd-sum">${pill(t.structures[result.structure], 'st')}<span>${esc(t.summary(result.applications.length, suggested))}</span>${result.tools.length > 0 ? `<small class="mu">${esc(t.tools(result.tools.join(', ')))}</small>` : ''}</p><small class="mu">${esc(result.keywords.length > 0 ? t.keywords(result.keywords.join(', ')) : t.noKeywords)}</small>`;
  const apps = `<ul class="inc-sd-apps" role="list">${result.applications.map((entry) => applicationCard(ctx, ui, entry, disabled)).join('')}</ul>`;
  const nameOf = (id: string): string =>
    result.applications.find((entry) => entry.application.id === id)?.application.name ?? id;
  const relations =
    result.relations.length > 0
      ? `<details class="inc-sd-more"><summary>${esc(t.relations(result.relations.length))}</summary><ul class="plain inc-sd-rel">${result.relations
          .map(
            (relation) =>
              `<li><b>${esc(nameOf(relation.from))}</b> <span class="mu">${esc(t.relationKinds[relation.kind] ?? relation.kind)}</span> <b>${esc(nameOf(relation.to))}</b> ${pill(t.relationStatus[relation.status] ?? relation.status)}<small class="mu block">${esc(relation.evidence)}</small></li>`,
          )
          .join('')}</ul></details>`
      : '';
  const denied =
    result.denied.length > 0
      ? `<details class="inc-sd-more"><summary>${esc(t.denied(result.denied.length))}</summary><ul class="plain">${result.denied.map((entry) => `<li><code>${esc(entry.path)}</code> <span class="mu">${esc(entry.reason)}</span></li>`).join('')}</ul></details>`
      : '';
  const truncated =
    result.truncated.length > 0
      ? `<details class="inc-sd-more"><summary>${esc(t.truncated)}</summary><ul class="plain">${result.truncated.map((entry) => `<li>${esc(entry)}</li>`).join('')}</ul></details>`
      : '';
  const read = `<details class="inc-sd-more"><summary>${esc(t.read(result.read.length))}</summary><p>${codes(result.read)}</p></details>`;
  const plan = applyPlan(ctx.incident, ui);
  const count =
    plan.kind === 'UPDATE' ? plan.added.length : plan.kind === 'EXTENSIONS' ? plan.requests.length : 0;
  const footer = disabled
    ? ''
    : `<div class="inc-sd-foot"><button type="button" class="btn ghost" data-action="inc-disc-clear"${busy ? ' disabled' : ''}>${esc(t.clear)}</button><small class="mu">${esc(plan.kind === 'EXTENSIONS' ? t.applyExtensionsHint : t.applyHint)}</small><button type="button" class="btn primary" data-action="inc-disc-apply" aria-describedby="inc-sd-apply-h"${count === 0 || busy ? ' disabled' : ''} aria-busy="${String(busy)}">${icon(plan.kind === 'EXTENSIONS' ? 'plus' : 'check')}<span>${esc(plan.kind === 'EXTENSIONS' ? t.applyExtensions(count) : t.apply(count))}</span></button><small id="inc-sd-apply-h" class="sr">${esc(count === 0 ? t.applyNone : plan.kind === 'EXTENSIONS' ? t.applyExtensionsHint : t.applyHint)}</small></div>`;
  return `<div class="inc-sd-res">${problems}${summary}${apps}${relations}${denied}${truncated}${read}${footer}</div>`;
}

/**
 * Le bloc « Applications et dépôts ». `opts.busy` : l'analyse ou l'ajout est en cours. Le formulaire
 * (`inc-disc-run`) lance l'analyse du chemin saisi ; un dépôt connu (`inc-disc-known`) remplit le chemin et
 * lance l'analyse.
 */
export function renderScopeDiscovery(
  ctx: ScopeContext,
  ui: DiscoveryUi,
  opts: { busy?: string } = {},
): string {
  const t = TEXT[ctx.lang];
  const editable = discoveryEditable(ctx);
  const running = opts.busy === 'inc-disc-run';
  const busy = opts.busy !== undefined;
  const disabled = !editable || busy;
  const note = ctx.demo
    ? `<p class="note">${icon('info')}<span>${esc(t.demo)}</span></p>`
    : !ctx.can('RUN')
      ? `<p class="note">${icon('info')}<span>${esc(t.readOnly)}</span></p>`
      : !editable
        ? `<p class="note">${icon('info')}<span>${esc(t.locked)}</span></p>`
        : '';
  const form = editable
    ? `<form class="inc-sd-form" data-action="inc-disc-run" novalidate><label class="field inc-sd-root" for="inc-sd-root">${esc(t.root)}<input id="inc-sd-root" data-inc="disc.root" class="mono" value="${esc(ui.root)}" placeholder="${esc(t.placeholder)}" autocomplete="off" spellcheck="false" aria-describedby="inc-sd-root-h"${busy ? ' disabled' : ''}></label><button type="submit" class="btn primary" data-action="inc-disc-run" aria-busy="${String(running)}"${busy ? ' disabled' : ''}>${running ? '<span class="spin sm" aria-hidden="true"></span>' : icon('search')}<span>${esc(running ? t.analyzing : t.analyze)}</span></button></form><small id="inc-sd-root-h" class="mu">${esc(t.rootHint)}</small>${knownBlock(ctx, ui, disabled)}`
    : '';
  const result = ui.result ? resultBlock(ctx, ui, ui.result, disabled, busy) : '';
  return `<section class="card wide inc-sd" aria-labelledby="inc-sd-t"><div class="inc-sd-head"><h2 id="inc-sd-t" class="fl">${icon('projects')}<span>${esc(t.title)}</span></h2><p class="mu">${esc(t.sub)}</p></div>${note}${form}${result}</section>`;
}

/** L'enveloppe de la section avancée (saisie manuelle), repliée par défaut. */
export function advancedDetails(lang: Lang, open: boolean, body: string): string {
  const t = TEXT[lang];
  return `<details class="inc-sd-adv"${open ? ' open' : ''}><summary data-action="inc-disc-advanced" data-open="${String(open)}">${esc(t.advanced)}</summary>${body}</details>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────

/** Les styles du bloc (préfixe `inc-sd-`) : jetons du thème seulement, clair et sombre. */
export const INCIDENT_SCOPE_DISCOVERY_CSS = `
.inc-sd{display:flex;flex-direction:column;gap:10px;min-width:0}
.inc-sd-head h2{margin:0;display:flex;align-items:center;gap:8px}
.inc-sd-head h2 .ico{width:18px;height:18px;color:var(--qa-color-muted)}
.inc-sd-head p{margin:2px 0 0}
.inc-sd-form{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.inc-sd-root{flex:1 1 320px;min-width:0}
.inc-sd-form .btn{flex:none}
.inc-sd-known{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0;font-size:13px}
.inc-sd-known{min-width:0;max-width:100%}
.inc-sd-chips{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px;min-width:0;max-width:100%}
.inc-sd-chips li{min-width:0;max-width:100%}
.inc-sd-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0;min-height:30px;padding:2px 10px;border:1px solid var(--qa-color-border);border-radius:999px;background:var(--qa-color-surface-2);color:var(--qa-color-text);font:inherit;font-size:12.5px;cursor:pointer;text-align:left}
.inc-sd-chip:hover:not(:disabled){border-color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 8%,var(--qa-color-surface))}
.inc-sd-chip:disabled{cursor:default;opacity:.7}
.inc-sd-chip .ico{width:14px;height:14px;color:var(--qa-color-muted);flex:none}
.inc-sd-chip code{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;background:transparent;border:0;padding:0;font-size:12px}
.inc-sd-chip-l{flex:0 1 auto;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.inc-sd-chip small{flex:none}
.inc-sd-res{display:flex;flex-direction:column;gap:10px;min-width:0}
.inc-sd-problems{border:1px solid var(--qa-color-border);border-left:3px solid var(--qa-color-warning);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--qa-color-surface)}
.inc-sd-problems[role="alert"]{border-left-color:var(--qa-color-danger)}
.inc-sd-problems p{margin:0}
.inc-sd-problems li{display:flex;gap:6px;align-items:flex-start;font-size:13px}
.inc-sd-problems .ico{width:16px;height:16px;flex:none;margin-top:2px;color:var(--qa-color-warning)}
.inc-sd-problems[role="alert"] .ico{color:var(--qa-color-danger)}
.inc-sd-sum{margin:0;display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;font-weight:600}
.inc-sd-sum small{font-weight:400}
.inc-sd-pill{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;white-space:nowrap;border:1px solid var(--qa-color-border);color:var(--qa-color-muted);background:var(--qa-color-surface-2)}
.inc-sd-pill.st,.inc-sd-pill.fw{color:var(--qa-color-primary);background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface))}
.inc-sd-pill.conf-high{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text));background:var(--qa-color-success-soft)}
.inc-sd-pill.conf-medium{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text));background:var(--qa-color-warning-soft)}
.inc-sd-pill.conf-low{color:color-mix(in srgb,var(--qa-color-danger) 75%,var(--qa-color-text));background:var(--qa-color-danger-soft)}
.inc-sd-pill.in{color:var(--qa-color-text)}
.inc-sd-apps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.inc-sd-app{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;background:var(--qa-color-surface);display:flex;flex-direction:column;gap:6px;min-width:0}
.inc-sd-app.on{border-color:var(--qa-color-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--qa-color-primary) 35%,transparent)}
.inc-sd-app.known{opacity:.85}
.inc-sd-app-h{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap;min-width:0}
.inc-sd-check{display:inline-flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex:1 1 240px}
.inc-sd-check input{width:16px;height:16px;accent-color:var(--qa-color-primary);margin:0;flex:none}
.inc-sd-check b{white-space:nowrap}
.inc-sd-check code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;background:transparent;border:0;padding:0;color:var(--qa-color-muted)}
.inc-sd-layer select{min-height:28px;padding:0 8px;border-radius:999px;border:1px solid var(--qa-color-border);font:inherit;font-size:12px;font-weight:600;background:var(--qa-color-surface-2);color:var(--qa-color-text)}
.inc-sd-layer select.inc-sd-l-frontend{color:var(--qa-color-primary)}
.inc-sd-layer select.inc-sd-l-bff{color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text))}
.inc-sd-layer select.inc-sd-l-backend{color:color-mix(in srgb,var(--qa-color-success) 62%,var(--qa-color-text))}
.inc-sd-why{margin:0;font-size:12.5px}
.inc-sd-q{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.inc-sd-q li{display:flex;gap:6px;align-items:flex-start;font-size:12.5px;color:color-mix(in srgb,var(--qa-color-warning) 75%,var(--qa-color-text))}
.inc-sd-q .ico{width:14px;height:14px;flex:none;margin-top:2px}
.inc-sd-det summary,.inc-sd-more summary{cursor:pointer;font-size:13px;color:var(--qa-color-primary);padding:2px 0}
.inc-sd-dl{margin:6px 0 0;display:flex;flex-direction:column;gap:6px}
.inc-sd-row{display:grid;grid-template-columns:minmax(120px,160px) minmax(0,1fr);gap:4px 10px;font-size:13px}
.inc-sd-row dt{color:var(--qa-color-muted);font-weight:600}
.inc-sd-row dd{margin:0;min-width:0;display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center}
.inc-sd-row dd p{margin:0}
.inc-sd-mods{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px 8px}
.inc-sd-mods li{display:inline-flex;align-items:center;gap:4px;font-size:12.5px}
.inc-sd-mods li.hit code{color:var(--qa-color-primary);border-color:var(--qa-color-primary)}
.inc-sd-mods small{color:var(--qa-color-muted)}
.inc-sd-ev{font-size:12.5px;display:flex;flex-direction:column;gap:2px}
.inc-sd-rel li{font-size:13px;padding:2px 0}
.inc-sd-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.inc-sd-foot small{flex:1 1 260px;min-width:0}
.inc-sd-foot .btn .ico{width:16px;height:16px}
.inc-sd-adv>summary{cursor:pointer;font-weight:600;font-size:14px;padding:6px 0;color:var(--qa-color-primary)}
.inc-sd-adv[open]>summary{margin-bottom:8px}
@container (max-width:640px){
  .inc-sd-row{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:640px){
  .inc-sd-row{grid-template-columns:minmax(0,1fr)}
}
`;
