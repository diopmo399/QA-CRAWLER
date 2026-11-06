import type {
  ChainStep,
  MapConfidence,
  Evidence,
  EvidenceKind,
  Feature,
  FieldConcept,
  FieldIssue,
  MapEdge,
  MapEdgeKind,
  MapLayer,
  MapNode,
  MapNodeKind,
  MapSource,
  MapContract,
  MapContractDiff,
  MapCorrelation,
  MapConfigGraph,
  MapModule,
  CorrelationCause,
  CorrelationStep,
} from '../sdk/core/cartography.js';
import type { CodeEndpoint } from '../sdk/core/incident-contracts.js';
import { matchEndpoint, normalizePath } from '../incident/code/paths.js';
import { membersOf } from './analyze-template.js';
import type { Loc, SourceFacts } from './facts.js';
import { ConfigResolver, DEFAULT_VARIANT } from './config.js';
import { buildConfigGraph } from './config-graph.js';
import { classifyQuery } from './data-access.js';
import {
  destinationOf,
  routedPath,
  routeMatches,
  servicesOf,
  type GatewayFacts,
  type GatewayRoute,
  type ServiceSource,
} from './gateway.js';
import {
  apiNamesOf,
  ContractIndex,
  generatedPrefix,
  joinRoute,
  matchCall,
  operationsFor,
  packageOf,
  sideOf,
  type Cause,
  type Match,
  type Target,
} from './correlate.js';

/**
 * LE GRAPHE FONCTIONNEL, construit à partir des faits de toutes les sources. Chaque lien dit pourquoi il
 * existe et ce qui le prouve :
 *   CONFIRMED  un mécanisme démontré par le code (liaison du gabarit, flux de données résolu, chemin et
 *              méthode HTTP littéraux, liaison JSON d'un corps identifié, mapping explicite, @Column) ;
 *   PROBABLE   une correspondance plausible mais non démontrée (adresse de base non résolue, même nom
 *              dans la même chaîne, nommage par défaut, appel hérité) — et ce qui manque est écrit ;
 *   UNKNOWN    l'étape n'a pas été retrouvée : « lien non démontré », jamais un lien inventé.
 * Deux champs ne sont jamais fusionnés parce qu'ils portent le même nom : seuls des liens les relient.
 */
const RANK: Record<MapConfidence, number> = { CONFIRMED: 2, PROBABLE: 1, UNKNOWN: 0 };
/** Les causes sans doublon (même code, même message). */
const dedupeCauses = (causes: readonly Cause[]): Cause[] => {
  const seen = new Set<string>();
  return causes.filter((c) => {
    const key = `${c.code}|${c.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const weakest = (...values: MapConfidence[]): MapConfidence =>
  values.reduce<MapConfidence>((low, value) => (RANK[value] < RANK[low] ? value : low), 'CONFIRMED');

/** « CreateRequestComponent » → « Create request » ; « validateRequest » → « Validate request ». */
export function humanize(name: string): string {
  const words = name
    .replace(/(Component|Page|Controller|Resource|Endpoint|Service)$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const last = (text: string): string => text.split('.').pop() ?? text;

/** Au plus autant d'étapes du frontal dans une chaîne (le reste est compté). */
const MAX_FRONT_STEPS = 10;

/** Le libellé d'une étape du frontal : appel HTTP, flux, ou méthode selon le rôle de sa classe. */
function frontLabel(n: MapNode): string {
  if (n.detail.httpMethod !== undefined) {
    const path = String(n.detail.path ?? '');
    return `${String(n.detail.httpMethod)} ${path || '(URL dynamique)'}`;
  }
  if (n.kind === 'STREAM') {
    const ops = Array.isArray(n.detail.operators) ? n.detail.operators.slice(0, 3).join(', ') : '';
    return `Flux ${n.name}${ops ? ` (${ops})` : ''}`;
  }
  const role = String(n.detail.role ?? '');
  const prefix = role === 'COMPONENT' ? 'Action' : role === 'STORE' ? 'Store' : 'Service';
  // Une méthode vue dans un contexte d'appel porte déjà ses arguments : « OrderStore.dispatch(OrderAction.Submit) ».
  return `${prefix} ${n.name}${n.name.endsWith(')') ? '' : '()'}`;
}

/** « RequestBffController.get » → « get Request » (l'action, puis la ressource). */
const handlerTitle = (handler: string): string => {
  const [owner = '', method = handler] = handler.includes('.') ? handler.split('.') : ['', handler];
  const resource = owner.replace(/(Bff|Api|Rest)?(Controller|Resource|Endpoint)$/, '');
  return resource ? `${method} ${resource}` : method;
};

export interface GraphInput {
  sources: readonly MapSource[];
  facts: readonly SourceFacts[];
}

export interface GraphOutput {
  nodes: MapNode[];
  edges: MapEdge[];
  features: Feature[];
  concepts: FieldConcept[];
  issues: FieldIssue[];
  correlations?: MapCorrelation[];
  contracts?: MapContract[];
  contractDiffs?: MapContractDiff[];
  modules?: MapModule[];
  configGraph?: MapConfigGraph;
}

/** Le type normalisé d'un champ, pour comparer les couches (text, number, date, boolean). */
export function normalizedType(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const t = type.toLowerCase();
  if (/^(string|text|char|charsequence|email|tel|password|search|url|uuid|varchar)/.test(t)) return 'text';
  if (/^(int|integer|long|short|double|float|bigdecimal|biginteger|number|byte)/.test(t)) return 'number';
  if (
    /^(date|localdate|localdatetime|instant|offsetdatetime|zoneddatetime|datetime|datetime-local|time)/.test(
      t,
    )
  )
    return 'date';
  if (/^(bool|boolean|checkbox)/.test(t)) return 'boolean';
  return undefined;
}

/** Les pistes de résolution d'une cause de rupture (jamais une correction automatique). */
const SUGGESTIONS: Partial<Record<CorrelationCause, string[]>> = {
  NO_ENDPOINT: [
    'ajouter la source qui sert cette route',
    'vérifier les préfixes en jeu (context-path, proxy, passerelle, base du contrat)',
  ],
  METHOD_MISMATCH: ['vérifier la méthode HTTP de l’appel et celle de l’endpoint'],
  AMBIGUOUS: ['établir la destination (proxy, base d’URL, configuration) pour départager les candidats'],
  DYNAMIC_URL: ['rendre l’URL lisible statiquement (constante, fichier environment, configuration)'],
  LAYER_MISSING: ['ajouter une source de la couche manquante'],
  CONTRACT_NOT_FOUND: ['ajouter le module de contrats aux sources, ou une racine de métadonnées locale'],
  MAVEN_MODULE_MISSING: ['ajouter le module Maven aux sources, ou une racine de métadonnées locale'],
  DEPENDENCY_UNAVAILABLE: ['déposer le pom et le jar de l’artefact dans une racine de métadonnées autorisée'],
  PROPERTY_UNRESOLVED: ['déclarer la propriété dans la configuration lue (fichier ou profil)'],
  DESTINATION_SYMBOLIC: ['fournir un profil ou un fichier de configuration qui donne la valeur'],
  GATEWAY_EXTERNAL: ['ajouter la configuration de la passerelle comme source'],
  PROXY_DYNAMIC: ['écrire la règle de proxy avec des valeurs littérales'],
  ENVIRONMENT_INCONSISTENT: ['préciser la variante (profil, configuration) réellement déployée'],
  GENERATION_OPTIONS_INSUFFICIENT: ['déclarer requestMappingMode dans les options de génération'],
  GENERATED_INTERFACE_ABSENT: [
    'ajouter le code généré aux sources, ou garder la route reconstruite du contrat',
  ],
  CONTRACT_NOT_IMPLEMENTED: ['ajouter la source qui implémente le contrat'],
  SOURCE_PARTIAL: ['relancer le scan avec des limites de lecture plus larges'],
  MULTIPLE_DESTINATIONS: ['préciser la destination (une seule source par adresse)'],
};

export function buildGraph(input: GraphInput): GraphOutput {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const revisionOf = new Map(input.facts.map((facts) => [facts.sourceId, facts.revision]));

  const ev = (
    sourceId: string,
    loc: Loc | undefined,
    kind: EvidenceKind,
    confidence: MapConfidence,
    detail?: string,
    symbol?: string,
  ): Evidence => {
    const revision = revisionOf.get(sourceId);
    return {
      kind,
      sourceId,
      ...(loc ? { file: loc.file, line: loc.line } : {}),
      ...(symbol ? { symbol } : {}),
      ...(revision ? { revision } : {}),
      confidence,
      ...(detail ? { detail } : {}),
    };
  };
  const node = (
    id: string,
    kind: MapNodeKind,
    layer: MapLayer,
    name: string,
    evidence: Evidence,
    detail: MapNode['detail'] = {},
    extra: Partial<Pick<MapNode, 'label' | 'parent'>> = {},
  ): string => {
    const existing = nodes.get(id);
    if (existing) {
      existing.evidence.push(evidence);
      return id;
    }
    const signature = Object.keys(detail)
      .sort()
      .filter((key) => !['line', 'file'].includes(key))
      .map((key) => `${key}=${JSON.stringify(detail[key])}`)
      .join(';');
    nodes.set(id, { id, kind, layer, name, ...extra, detail, signature, evidence: [evidence] });
    return id;
  };
  const edge = (
    from: string,
    to: string,
    kind: MapEdgeKind,
    confidence: MapConfidence,
    reason: string,
    evidence: Evidence[],
    detail?: MapEdge['detail'],
  ): void => {
    if (!nodes.has(from) || !nodes.has(to) || from === to) return;
    const id = `${kind}:${from}->${to}`;
    const existing = edges.get(id);
    if (existing) {
      if (RANK[confidence] > RANK[existing.confidence])
        Object.assign(existing, { confidence, reason, ...(detail ? { detail } : {}) });
      existing.evidence.push(...evidence);
      return;
    }
    edges.set(id, { id, from, to, kind, confidence, reason, evidence, ...(detail ? { detail } : {}) });
  };

  // ── Nœuds, source par source ─────────────────────────────────────────────────────────────────
  interface Served {
    endpoint: CodeEndpoint;
    sourceId: string;
    requestBody?: string;
    layer: MapLayer;
    /**
     * Les chemins sous lesquels il est atteint (préfixe d'exposition, bases du contrat) et ce qui les
     * justifie ; INFERRED : endpoint déduit d'une interface générée absente (route du contrat).
     */
    exposed?: string[];
    why?: string[];
    kind?: 'SERVED' | 'INFERRED';
    /** Les chemins exposés dans une variante (profil) qui remplacent ceux du défaut pour cette variante. */
    byVariant?: Record<string, { paths: string[]; why: string[] }>;
  }
  /** Les chemins exposés d'une route : préfixe du défaut, et préfixe propre à chaque profil qui en déclare un. */
  const exposurePaths = (
    exposure:
      readonly { key: string; value: string; file: string; line: number; profile?: string }[] | undefined,
    paths: readonly string[],
    extraWhy: readonly string[] = [],
  ): Pick<Served, 'exposed' | 'why' | 'byVariant'> => {
    const why = (e: { key: string; value: string; file: string; line: number; profile?: string }): string =>
      `préfixe ${e.key} = ${e.value} (${e.file}:${String(e.line)}${e.profile ? `, profil ${e.profile}` : ''})`;
    const def = exposure?.find((e) => !e.profile);
    const byVariant: Record<string, { paths: string[]; why: string[] }> = {};
    for (const e of exposure ?? [])
      if (e.profile)
        byVariant[e.profile] = { paths: paths.map((p) => joinRoute(e.value, p)), why: [why(e), ...extraWhy] };
    return {
      exposed: paths.map((p) => (def ? joinRoute(def.value, p) : p)),
      why: [...(def ? [why(def)] : []), ...extraWhy],
      ...(Object.keys(byVariant).length ? { byVariant } : {}),
    };
  };
  const served: Served[] = [];
  const contracts: Served[] = [];
  /** Le nœud de chaque opération de contrat (source|opération). */
  const opNodes = new Map<string, string>();
  const opNodeOf = (sourceId: string, opId: string): string =>
    opNodes.get(`${sourceId}|${opId}`) ?? `API:${sourceId}:${opId}`;
  const javaClasses = new Map<
    string,
    { sourceId: string; layer: MapLayer; cls: NonNullable<SourceFacts['java']>['classes'][number] }[]
  >();
  for (const facts of input.facts) {
    const src = facts.sourceId;
    const layer = sourceById.get(src)?.layer ?? facts.layer;
    if (facts.ui) {
      const ui = facts.ui;
      for (const component of ui.components)
        node(
          `COMPONENT:${src}:${component.name}`,
          'COMPONENT',
          'FRONTEND',
          component.name,
          ev(src, component.loc, 'STATIC_CODE', 'CONFIRMED', 'composant Angular', component.name),
          component.selector ? { selector: component.selector } : {},
        );
      for (const route of ui.routes) {
        const id = node(
          `ROUTE:${src}:${route.path}`,
          'ROUTE',
          'FRONTEND',
          route.path || '/',
          ev(src, route.loc, 'STATIC_CODE', 'CONFIRMED', 'route déclarée'),
          { path: route.path, ...(route.component ? { component: route.component } : {}) },
        );
        if (route.component)
          edge(
            id,
            `COMPONENT:${src}:${route.component}`,
            'DISPLAYS',
            'CONFIRMED',
            'la route affiche ce composant',
            [ev(src, route.loc, 'STATIC_CODE', 'CONFIRMED')],
          );
      }
      for (const field of ui.fields) {
        const required = field.validators.some(
          (validator) => validator === 'required' || validator === 'requiredTrue',
        );
        const maxLength = field.validators
          .find((validator) => validator.startsWith('maxLength:'))
          ?.split(':')[1];
        const id = node(
          `FIELD:${src}:${field.id}`,
          'FIELD',
          'FRONTEND',
          field.control,
          ev(src, field.loc, 'STATIC_CODE', 'CONFIRMED', `contrôle ${field.control} du formulaire`, field.id),
          {
            container: field.component,
            type: field.inputType ?? field.tag ?? 'text',
            required,
            validations: field.validators,
            ...(maxLength ? { maxLength: Number(maxLength) } : {}),
            bound: field.bound,
            ...(field.labelHow ? { labelSource: field.labelHow } : {}),
          },
          { ...(field.label ? { label: field.label } : {}), parent: `COMPONENT:${src}:${field.component}` },
        );
        edge(
          `COMPONENT:${src}:${field.component}`,
          id,
          'INPUTS',
          field.bound ? 'CONFIRMED' : 'PROBABLE',
          field.bound
            ? 'le gabarit relie un élément de saisie à ce contrôle'
            : 'contrôle déclaré, mais aucun élément du gabarit ne le relie',
          [ev(src, field.loc, 'TEMPLATE', field.bound ? 'CONFIRMED' : 'PROBABLE')],
        );
      }
      for (const dto of ui.dtos) {
        const dtoId = node(
          `DTO:${src}:${dto.name}`,
          'DTO',
          'FRONTEND',
          dto.name,
          ev(src, dto.loc, 'STATIC_CODE', 'CONFIRMED', 'type de données (frontal)'),
          { properties: dto.properties.map((p) => p.name) },
        );
        for (const property of dto.properties)
          node(
            `FIELD:${src}:${dto.name}.${property.name}`,
            'FIELD',
            'FRONTEND',
            property.name,
            ev(src, dto.loc, 'STATIC_CODE', 'CONFIRMED', `propriété du type ${dto.name}`),
            { container: dto.name, type: property.type ?? 'unknown', required: !property.optional },
            { parent: dtoId },
          );
      }
      for (const call of ui.calls)
        node(
          `METHOD:${src}:${call.id}`,
          'METHOD',
          'FRONTEND',
          call.id.replace('#', '.'),
          ev(
            src,
            call.loc,
            'STATIC_CODE',
            'CONFIRMED',
            `appel HTTP ${call.method} ${call.path ?? '(chemin dynamique)'}`,
            call.id,
          ),
          {
            httpMethod: call.method,
            path: call.path ?? '',
            ...(call.bodyType ? { bodyType: call.bodyType } : {}),
            ...(call.via ? { via: call.via } : {}),
            ...(call.expression ? { urlExpression: call.expression } : {}),
            ...(call.unresolved ? { unresolved: call.unresolved } : {}),
          },
        );
      // Les stores et flux RxJS : méthodes traversées (composant, store, service) et flux.
      const diagnosticsOf = new Map<string, string[]>();
      for (const d of ui.diagnostics ?? []) {
        const owner = d.from.split('#')[0] ?? '';
        // Pour l'écran, chaque rupture dit de quelle action elle part ; pour la méthode, la rupture seule.
        for (const [key, text] of [
          [owner, d.code === 'UI_DYNAMIC' ? d.message : `${d.from.replace('#', '.')}() — ${d.message}`],
          [d.from, d.message],
        ] as const)
          diagnosticsOf.set(key, [...new Set([...(diagnosticsOf.get(key) ?? []), text])].slice(0, 6));
      }
      for (const sym of ui.symbols ?? []) {
        const stream = sym.stream;
        const id = `${stream ? 'STREAM' : 'METHOD'}:${src}:${sym.id}`;
        // Ce qui compte pour l'impact (rôle, point d'entrée, nature du flux, opérateurs, consommation) fait la
        // signature d'un nœud nouveau ; un appel HTTP déjà connu garde la sienne (pas de faux changement face
        // à un scan d'avant).
        const detail: MapNode['detail'] = {
          role: sym.role,
          owner: sym.owner,
          ...(sym.entry ? { entry: sym.entry } : {}),
          ...(sym.of
            ? {
                of: `METHOD:${src}:${sym.of}`,
                context: sym.context ?? '',
                branchesKept: sym.branches?.kept ?? 0,
                branchesPruned: sym.branches?.pruned ?? 0,
                branchesUnknown: sym.branches?.unknown ?? 0,
              }
            : {}),
          ...(stream
            ? {
                streamKind: stream.kind,
                ...(stream.type ? { subjectType: stream.type } : {}),
                operators: stream.operators,
                consumed: stream.consumed,
                ...(stream.filters ? { filters: stream.filters } : {}),
                ...(stream.reads ? { reads: stream.reads } : {}),
              }
            : {}),
        };
        const known = nodes.get(id);
        if (known) Object.assign(known.detail, detail);
        node(
          id,
          stream ? 'STREAM' : 'METHOD',
          'FRONTEND',
          stream ? sym.id : sym.of ? `${sym.owner}.${sym.name}` : sym.id.replace('#', '.'),
          ev(
            src,
            sym.loc,
            'STATIC_CODE',
            'CONFIRMED',
            stream
              ? `${stream.kind === 'SUBJECT' ? (stream.type ?? 'Subject') : 'Observable calculé'} ${sym.id}`
              : `méthode ${sym.id.replace('#', '.')}() (${sym.role.toLowerCase()})`,
            sym.id,
          ),
          known ? {} : detail,
          sym.role === 'COMPONENT' ? { parent: `COMPONENT:${src}:${sym.owner}` } : {},
        );
        const created = nodes.get(id)?.detail;
        if (created && stream?.consumers) created.consumers = stream.consumers;
        if (created && diagnosticsOf.get(sym.id)) created.diagnostics = diagnosticsOf.get(sym.id) ?? [];
      }
      for (const [owner, messages] of diagnosticsOf) {
        const detail = nodes.get(`COMPONENT:${src}:${owner}`)?.detail;
        if (detail) detail.diagnostics = messages;
      }
    }
    if (facts.java) {
      const java = facts.java;
      const backLayer: MapLayer = layer === 'BFF' ? 'BFF' : 'BACKEND';
      // Le préfixe sous lequel l'application expose ses routes (context-path…), lu dans sa configuration.
      const exposure = java.exposure?.find((e) => !e.profile);
      for (const cls of java.classes) {
        javaClasses.set(cls.name, [
          ...(javaClasses.get(cls.name) ?? []),
          { sourceId: src, layer: backLayer, cls },
        ]);
        if (cls.role === 'ENTITY') {
          const entityId = node(
            `ENTITY:${src}:${cls.name}`,
            'ENTITY',
            'DATABASE',
            cls.table ?? cls.name,
            ev(
              src,
              cls.loc,
              'STATIC_CODE',
              cls.tableHow === 'annotation' ? 'CONFIRMED' : 'PROBABLE',
              cls.tableHow === 'annotation'
                ? `@Table(name = "${cls.table ?? ''}")`
                : `table par nommage par défaut (${cls.table ?? ''})`,
              cls.qualified,
            ),
            { entity: cls.name, table: cls.table ?? '', tableSource: cls.tableHow ?? 'default' },
          );
          for (const field of cls.fields) {
            if (!field.column) continue;
            node(
              `COLUMN:${src}:${cls.name}.${field.name}`,
              'COLUMN',
              'DATABASE',
              `${cls.table ?? cls.name}.${field.column}`,
              ev(
                src,
                { file: cls.loc.file, line: field.line },
                'STATIC_CODE',
                field.columnHow === 'annotation' ? 'CONFIRMED' : 'PROBABLE',
                field.columnHow === 'annotation'
                  ? `@Column(name = "${field.column}")`
                  : `colonne par nommage par défaut (${field.column})`,
                `${cls.name}.${field.name}`,
              ),
              {
                container: cls.name,
                field: field.name,
                column: field.column,
                columnSource: field.columnHow ?? 'default',
                type: field.type,
                required: field.required,
                validations: field.validations,
                ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
              },
              { parent: entityId },
            );
          }
        } else if (cls.role === 'DTO') {
          // Une classe qui ne déclare aucune contrainte ne dit rien du caractère obligatoire de ses champs.
          const constrained = cls.fields.some((field) => field.validations.length > 0);
          const dtoId = node(
            `DTO:${src}:${cls.name}`,
            'DTO',
            backLayer,
            cls.name,
            ev(src, cls.loc, 'STATIC_CODE', 'CONFIRMED', 'objet de transfert', cls.qualified),
            { properties: cls.fields.map((field) => field.name) },
          );
          for (const field of cls.fields)
            node(
              `FIELD:${src}:${cls.name}.${field.name}`,
              'FIELD',
              backLayer,
              field.jsonName ?? field.name,
              ev(
                src,
                { file: cls.loc.file, line: field.line },
                'STATIC_CODE',
                'CONFIRMED',
                `champ ${field.name} de ${cls.name}`,
                `${cls.name}.${field.name}`,
              ),
              {
                container: cls.name,
                javaField: field.name,
                type: field.type,
                required: field.required,
                constrained,
                validations: field.validations,
                ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
              },
              { parent: dtoId },
            );
        } else if (cls.role === 'SERVICE' || cls.role === 'REPOSITORY' || cls.role === 'CLIENT')
          node(
            `SERVICE:${src}:${cls.name}`,
            'SERVICE',
            backLayer,
            cls.name,
            ev(
              src,
              cls.loc,
              'STATIC_CODE',
              'CONFIRMED',
              cls.role === 'REPOSITORY' ? `dépôt de ${cls.repositoryOf ?? '?'}` : 'service',
              cls.qualified,
            ),
            { role: cls.role, ...(cls.repositoryOf ? { entity: cls.repositoryOf } : {}) },
          );
      }
      for (const method of java.methods)
        node(
          `METHOD:${method.id}`,
          'METHOD',
          backLayer,
          `${method.owner}.${method.name}`,
          ev(src, method.loc, 'STATIC_CODE', 'CONFIRMED', `méthode de ${method.owner}`, method.id),
          { owner: method.owner, role: method.role, ...(method.access ? { access: method.access } : {}) },
        );
      for (const method of java.methods) {
        const owner = `SERVICE:${src}:${method.owner}`;
        if (nodes.has(owner))
          edge(owner, `METHOD:${method.id}`, 'DEPENDS_ON', 'CONFIRMED', 'méthode de la classe', [
            ev(src, method.loc, 'STATIC_CODE', 'CONFIRMED'),
          ]);
        if (method.role === 'REPOSITORY') {
          const repository = java.classes.find((entry) => entry.name === method.owner);
          const entity = repository?.repositoryOf ? `ENTITY:${src}:${repository.repositoryOf}` : undefined;
          const shape = method.query ? classifyQuery(method.query.text) : undefined;
          if (entity)
            edge(
              `METHOD:${method.id}`,
              entity,
              method.access === 'WRITE' ? 'WRITES' : 'READS',
              'CONFIRMED',
              shape && shape.operation !== 'UNKNOWN'
                ? `dépôt Spring Data de ${repository?.repositoryOf ?? ''} : requête @Query ${method.query?.native ? 'SQL native' : 'JPQL'} (${shape.operation})`
                : `dépôt Spring Data de ${repository?.repositoryOf ?? ''} (${method.access === 'WRITE' ? 'écriture' : 'lecture'} d’après le nom)`,
              [ev(src, method.loc, 'STATIC_CODE', 'CONFIRMED')],
              shape
                ? {
                    operation: shape.operation,
                    ...(method.query ? { statement: method.query.text.slice(0, 240) } : {}),
                  }
                : undefined,
            );
        }
      }
      // Les accès hors Spring Data (EntityManager, JdbcTemplate) : la cible est l'entité citée (JPQL), ou la
      // table citée (SQL) rattachée à l'entité qui la déclare ; une table qu'aucune entité ne déclare devient
      // un nœud de données non mappé. Une opération illisible reste une dépendance probable, jamais une écriture.
      for (const access of java.dataAccess ?? []) {
        const targets = access.targets.length ? access.targets : [];
        for (const t of targets) {
          const entity =
            t.kind === 'ENTITY'
              ? java.classes.find((c) => c.role === 'ENTITY' && c.name === t.name)
              : java.classes.find(
                  (c) => c.role === 'ENTITY' && c.table?.toLowerCase() === t.name.toLowerCase(),
                );
          const target = entity
            ? `ENTITY:${src}:${entity.name}`
            : node(
                `ENTITY:${src}:table:${t.name}`,
                'ENTITY',
                backLayer,
                t.name,
                ev(src, access.loc, 'STATIC_CODE', 'PROBABLE', `table ${t.name} citée par ${access.via}`),
                { table: t.name, mapped: false },
              );
          const known = access.operation !== 'UNKNOWN';
          edge(
            `METHOD:${access.from}`,
            target,
            !known ? 'DEPENDS_ON' : access.operation === 'SELECT' ? 'READS' : 'WRITES',
            known && entity ? 'CONFIRMED' : 'PROBABLE',
            `${access.via} (${access.mechanism === 'JPQL' ? 'JPQL' : access.mechanism === 'NATIVE_SQL' ? 'SQL natif' : access.mechanism === 'JDBC' ? 'JDBC' : 'EntityManager'}) : ${known ? access.operation : 'opération non lisible'} de ${t.name}${entity ? '' : ' (aucune entité ne déclare cette table)'}`,
            [ev(src, access.loc, 'STATIC_CODE', known && entity ? 'CONFIRMED' : 'PROBABLE')],
            { operation: access.operation, ...(access.statement ? { statement: access.statement } : {}) },
          );
        }
      }
      for (const access of java.repositoryAccess ?? []) {
        const entity = `ENTITY:${src}:${access.entity}`;
        edge(
          `METHOD:${access.from}`,
          entity,
          access.access === 'WRITE' ? 'WRITES' : 'READS',
          'CONFIRMED',
          `${access.repository}.${access.operation}() (${access.access === 'WRITE' ? 'écriture' : 'lecture'} de ${access.entity}, d’après le nom de l’opération Spring Data)`,
          [ev(src, access.loc, 'STATIC_CODE', 'CONFIRMED')],
        );
      }
      for (const endpoint of java.endpoints) {
        const id = node(
          `API:${src}:${endpoint.id}`,
          'API',
          backLayer,
          endpoint.id,
          ev(
            src,
            endpoint.loc,
            'STATIC_CODE',
            'CONFIRMED',
            `endpoint servi par ${endpoint.handlerName}`,
            endpoint.handler,
          ),
          {
            httpMethod: endpoint.method,
            path: endpoint.path,
            handler: endpoint.handlerName,
            ...(endpoint.requestBody ? { requestBody: endpoint.requestBody } : {}),
            ...(endpoint.returns ? { returns: endpoint.returns } : {}),
            ...(endpoint.validated !== undefined ? { validated: endpoint.validated } : {}),
            ...(endpoint.via ? { declaredBy: endpoint.via.type, controller: endpoint.controller ?? '' } : {}),
            ...(exposure ? { exposedPath: joinRoute(exposure.value, endpoint.path) } : {}),
          },
        );
        // Une route héritée : l'annotation est sur un type parent (interface, classe de base).
        if (endpoint.via)
          nodes
            .get(id)
            ?.evidence.push(
              ev(
                src,
                { file: endpoint.via.file, line: endpoint.via.line },
                'STATIC_CODE',
                'CONFIRMED',
                `route déclarée par ${endpoint.via.type}, exposée par ${endpoint.controller ?? ''}`,
              ),
            );
        edge(
          id,
          `METHOD:${endpoint.handler}`,
          'DEPENDS_ON',
          'CONFIRMED',
          'méthode du contrôleur qui sert l’endpoint',
          [ev(src, endpoint.loc, 'STATIC_CODE', 'CONFIRMED')],
        );
        if (endpoint.requestBody)
          edge(id, `DTO:${src}:${endpoint.requestBody}`, 'READS', 'CONFIRMED', '@RequestBody de l’endpoint', [
            ev(src, endpoint.loc, 'STATIC_CODE', 'CONFIRMED'),
          ]);
        served.push({
          endpoint: {
            applicationId: src,
            layer: backLayer === 'BFF' ? 'BFF' : 'BACKEND',
            method: endpoint.method,
            path: endpoint.path,
            symbolId: id,
          },
          sourceId: src,
          ...(endpoint.requestBody ? { requestBody: endpoint.requestBody } : {}),
          layer: backLayer,
          kind: 'SERVED',
          ...exposurePaths(java.exposure, [endpoint.path]),
        });
      }
      for (const call of java.calls)
        if (call.to)
          edge(
            `METHOD:${call.from}`,
            `METHOD:${call.to}`,
            'CALLS',
            call.status === 'STATICALLY_RESOLVED' ? 'CONFIRMED' : 'PROBABLE',
            call.status === 'STATICALLY_RESOLVED'
              ? 'appel résolu par le type'
              : 'appel résolu par héritage ou implémentation unique',
            [
              ev(
                src,
                call.loc,
                'STATIC_CODE',
                call.status === 'STATICALLY_RESOLVED' ? 'CONFIRMED' : 'PROBABLE',
              ),
            ],
          );
      for (const mapping of java.mappings) {
        const from = fieldNode(src, mapping.fromClass, mapping.fromField);
        const to = fieldNode(src, mapping.toClass, mapping.toField);
        if (from && to)
          edge(
            from,
            to,
            'TRANSFORMS',
            'CONFIRMED',
            `correspondance explicite (${mapping.how === 'setter' ? 'setter' : 'builder'}) dans ${mapping.method}`,
            [ev(src, mapping.loc, 'STATIC_CODE', 'CONFIRMED', undefined, mapping.method)],
          );
      }
    }
    if (facts.openapi) {
      for (const schema of facts.openapi.schemas) {
        const dtoId = node(
          `DTO:${src}:${schema.name}`,
          'DTO',
          'API',
          schema.name,
          ev(src, schema.loc, 'OPENAPI', 'CONFIRMED', 'schéma du contrat d’API'),
          { properties: schema.properties.map((p) => p.name) },
        );
        for (const property of schema.properties)
          node(
            `FIELD:${src}:${schema.name}.${property.name}`,
            'FIELD',
            'API',
            property.name,
            ev(src, schema.loc, 'OPENAPI', 'CONFIRMED', `propriété du schéma ${schema.name}`),
            {
              container: schema.name,
              type: property.format ?? property.type,
              required: property.required,
              ...(property.maxLength !== undefined ? { maxLength: property.maxLength } : {}),
              ...(property.pattern ? { pattern: property.pattern } : {}),
            },
            { parent: dtoId },
          );
      }
      for (const op of facts.openapi.operations) {
        // Un contrat produit depuis le code vit dans la source de ses contrôleurs : son opération ne doit pas
        // se confondre avec l'endpoint servi de même méthode et même chemin.
        const clash = nodes.get(`API:${src}:${op.id}`);
        const opId = clash && clash.layer !== 'API' ? `API:${src}:contract:${op.id}` : `API:${src}:${op.id}`;
        opNodes.set(`${src}|${op.id}`, opId);
        const id = node(
          opId,
          'API',
          'API',
          op.id,
          ev(src, op.loc, 'OPENAPI', 'CONFIRMED', op.summary ?? op.operationId ?? 'opération du contrat'),
          {
            httpMethod: op.method,
            path: op.path,
            ...(op.operationId ? { operationId: op.operationId } : {}),
            ...(op.summary ? { summary: op.summary } : {}),
            tags: op.tags,
            ...(op.request ? { requestBody: op.request } : {}),
            ...(op.response ? { response: op.response } : {}),
            ...(op.unresolved ? { unresolvedRefs: op.unresolved } : {}),
          },
        );
        if (op.request)
          edge(id, `DTO:${src}:${op.request}`, 'READS', 'CONFIRMED', 'corps de requête du contrat', [
            ev(src, op.loc, 'OPENAPI', 'CONFIRMED'),
          ]);
        // Le chemin documenté : avec chaque base du contrat (servers, basePath), et tel qu'écrit.
        const documented = (op.bases ?? []).map((base) => joinRoute(base, op.route ?? op.path));
        contracts.push({
          endpoint: { applicationId: src, layer: 'BACKEND', method: op.method, path: op.path, symbolId: id },
          sourceId: src,
          ...(op.request ? { requestBody: op.request } : {}),
          layer: 'API',
          exposed: [...new Set([...documented, op.path])],
          why: documented.length ? [`base déclarée par le contrat : ${(op.bases ?? []).join(', ')}`] : [],
        });
      }
    }
  }

  function fieldNode(src: string, cls: string, field: string): string | undefined {
    for (const prefix of ['FIELD', 'COLUMN'])
      if (nodes.has(`${prefix}:${src}:${cls}.${field}`)) return `${prefix}:${src}:${cls}.${field}`;
    return undefined;
  }
  /** Le champ JSON d'une classe de corps : par son nom JSON (@JsonProperty) ou son nom. */
  const jsonField = (src: string, cls: string, key: string): string | undefined => {
    const java = javaClasses.get(cls)?.find((entry) => entry.sourceId === src)?.cls;
    const field = java?.fields.find((entry) => (entry.jsonName ?? entry.name) === key);
    if (field) return fieldNode(src, cls, field.name);
    return nodes.has(`FIELD:${src}:${cls}.${key}`) ? `FIELD:${src}:${cls}.${key}` : undefined;
  };

  // ── Contrats, modules, endpoints déduits d'une interface générée absente ──────────────────────
  const contractIndex = new ContractIndex(input.facts);
  const correlations: MapCorrelation[] = [];
  /** Les étapes et causes de la déduction d'un endpoint (module, génération, contrat, interface, méthode). */
  const derivation = new Map<string, { steps: CorrelationStep[]; causes: Cause[] }>();
  /** Les opérations d'un contrat d'entrée serveur que rien n'implémente, et pourquoi. */
  const notImplemented = new Map<string, string>();
  const usedOps = new Set<string>();
  const serverInputs: {
    sourceId: string;
    module: string;
    contract: NonNullable<ReturnType<ContractIndex['resolveSpec']>['contract']>;
  }[] = [];
  for (const { sourceId, module } of input.facts.flatMap((f) =>
    (f.maven?.modules ?? []).map((module) => ({ sourceId: f.sourceId, module })),
  ))
    for (const g of module.generations)
      if (sideOf(g) === 'SERVER') {
        const resolved = contractIndex.resolveSpec(sourceId, module, g);
        if (resolved.contract)
          serverInputs.push({
            sourceId,
            module: `${module.groupId ?? '?'}:${module.artifactId}`,
            contract: resolved.contract,
          });
      }
  const flagHandler = (handler: string, why: string): void => {
    const detail = nodes.get(`METHOD:${handler}`)?.detail;
    if (detail) detail.correlation = why;
  };
  for (const facts of input.facts) {
    const src = facts.sourceId;
    const java = facts.java;
    if (!java) continue;
    const layer: MapLayer = (sourceById.get(src)?.layer ?? facts.layer) === 'BFF' ? 'BFF' : 'BACKEND';
    const exposure = java.exposure?.find((e) => !e.profile);
    for (const impl of java.implementations ?? []) {
      const owner = contractIndex.moduleOf(src, impl.loc.file);
      for (const missing of impl.missing) {
        const pkg = missing.qualified ? packageOf(missing.qualified) : '';
        // Une génération du build par défaut d'abord ; une génération propre à un profil Maven n'est retenue
        // que s'il n'y en a pas d'autre, et elle le dit (le profil actif n'est pas connu).
        const generations = (owner?.module.generations ?? []).filter(
          (g) => g.apiPackage === pkg && sideOf(g) === 'SERVER',
        );
        const generation = generations.find((g) => !g.profile) ?? generations[0];
        const profileCause: Cause[] = generation?.profile
          ? [
              {
                code: 'PROFILE_UNKNOWN',
                message: `la génération ${generation.execution ?? generation.generator ?? ''} n’existe que dans le profil Maven ${generation.profile}${
                  generations.length > 1
                    ? ` (aussi dans : ${generations
                        .slice(1)
                        .map((g) => g.profile ?? 'défaut')
                        .join(', ')})`
                    : ''
                } : le profil actif n’est pas connu`,
              },
            ]
          : [];
        if (!owner || !generation) {
          for (const m of impl.methods)
            flagHandler(
              m.handler,
              `interface ${missing.qualified ?? missing.name} absente des sources, et produite par aucune génération serveur lisible ${owner ? `du module ${owner.module.artifactId}` : '(aucun pom.xml pour ce fichier)'} : route non démontrée`,
            );
          continue;
        }
        const resolved = contractIndex.resolveSpec(owner.sourceId, owner.module, generation);
        const contract = resolved.contract;
        if (!contract) {
          for (const m of impl.methods)
            flagHandler(
              m.handler,
              `interface ${missing.name} générée par ${generation.execution ?? generation.generator ?? ''} : ${resolved.causes.map((c) => c.message).join(' ; ')}`,
            );
          continue;
        }
        const ops = contractIndex.operations(contract);
        const genEv = ev(
          owner.sourceId,
          { file: owner.module.file, line: generation.line },
          'STATIC_CODE',
          'CONFIRMED',
          `génération ${generation.execution ?? ''}`,
        );
        for (const m of impl.methods) {
          const found = operationsFor(ops, generation, missing.name, m.name);
          const op = found[0];
          if (!op || found.length > 1) {
            flagHandler(
              m.handler,
              found.length > 1
                ? `${String(found.length)} opérations du contrat ${contract.doc.file} donnent ${missing.name}.${m.name} : aucune n’est choisie`
                : `aucune opération du contrat ${contract.doc.file} n’a pour operationId ${m.name} dans l’interface ${missing.name}`,
            );
            continue;
          }
          const route = op.route ?? op.path;
          const opNode = opNodeOf(contract.sourceId, op.id);
          usedOps.add(opNode);
          // Le préfixe de type de l'interface générée : démontré par une option ou le contrôleur, sinon les
          // possibilités sont gardées (jamais un préfixe inventé).
          const config = new ConfigResolver(facts.config ?? { entries: [], profiles: [] });
          const prefix = generatedPrefix(
            generation,
            impl.basePath,
            op.bases ?? [],
            [
              ...new Set(
                (facts.config?.entries ?? [])
                  .filter((e) => /^openapi\.[^.]+\.base-path$/.test(e.key))
                  .map((e) => e.key),
              ),
            ].map((key) => ({
              key,
              ...(config.resolve(key).value !== undefined ? { value: config.resolve(key).value } : {}),
            })),
          );
          const routes = prefix.prefixes.map((p) => joinRoute(p, route));
          const id = node(
            `API:${src}:${op.method} ${route}`,
            'API',
            layer,
            `${op.method} ${route}`,
            ev(
              src,
              m.loc,
              'STATIC_CODE',
              'PROBABLE',
              `endpoint déduit : ${impl.controller}.${m.name} implémente ${missing.name}, générée depuis ${contract.doc.file}`,
              m.handler,
            ),
            {
              httpMethod: op.method,
              path: route,
              handler: `${impl.controller}.${m.name}`,
              inferred: true,
              generatedInterface: missing.qualified ?? missing.name,
              ...(op.request ? { requestBody: op.request } : {}),
              ...(exposure ? { exposedPath: joinRoute(exposure.value, routes[0] ?? route) } : {}),
              routeOrigin: 'RECONSTRUCTED',
              typePrefix:
                prefix.status === 'DETERMINED' ? (prefix.prefixes[0] ?? '') || '(aucun)' : 'indéterminé',
              prefixRule: prefix.rule,
            },
          );
          edge(
            id,
            `METHOD:${m.handler}`,
            'DEPENDS_ON',
            'PROBABLE',
            `méthode qui implémente l’opération ${op.operationId ?? op.id} de l’interface générée ${missing.name}`,
            [ev(src, m.loc, 'STATIC_CODE', 'PROBABLE')],
          );
          edge(
            id,
            opNode,
            'DEPENDS_ON',
            'CONFIRMED',
            `route tirée du contrat ${contract.doc.file} lu par la génération ${generation.execution ?? generation.generator ?? ''}`,
            [ev(contract.sourceId, op.loc, 'OPENAPI', 'CONFIRMED')],
          );
          served.push({
            endpoint: {
              applicationId: src,
              layer: layer === 'BFF' ? 'BFF' : 'BACKEND',
              method: op.method,
              path: route,
              symbolId: id,
            },
            sourceId: src,
            layer,
            kind: 'INFERRED',
            ...exposurePaths(java.exposure, routes, [
              'route tirée du contrat (interface générée absente des sources)',
              `préfixe de l’interface : ${prefix.rule}`,
            ]),
          });
          derivation.set(id, {
            steps: [
              {
                kind: 'MODULE',
                label: `module ${owner.module.groupId ?? '?'}:${owner.module.artifactId}:${owner.module.version ?? '?'}`,
                evidence: genEv,
              },
              {
                kind: 'GENERATION',
                label: `génération ${generation.execution ?? ''} (${generation.generator ?? ''}, apiPackage ${pkg})`,
                evidence: genEv,
              },
              ...resolved.steps.map((st): CorrelationStep => ({ kind: 'CONTRACT', label: st.label })),
              {
                kind: 'INTERFACE',
                label: `interface ${missing.qualified ?? missing.name} : générée au build, absente des sources`,
              },
              {
                kind: 'IMPLEMENTATION',
                label: `${impl.controller}.${m.name} (@Override, operationId ${op.operationId ?? ''})`,
                node: `METHOD:${m.handler}`,
                evidence: ev(src, m.loc, 'STATIC_CODE', 'CONFIRMED'),
              },
            ],
            causes: [
              {
                code: 'GENERATED_INTERFACE_ABSENT',
                message: `l’interface ${missing.name} est générée au build (code absent des sources) : la route est reconstruite depuis le contrat`,
              },
              ...(prefix.status === 'UNDETERMINED'
                ? [
                    {
                      code: 'GENERATION_OPTIONS_INSUFFICIENT' as const,
                      message: `${prefix.rule} ; possibilités gardées : ${prefix.prefixes.map((p) => `« ${p || '(aucun)'} »`).join(', ')} ; il faudrait l’option requestMappingMode, un @RequestMapping sur ${impl.controller}, ou le code généré`,
                    },
                  ]
                : []),
              ...resolved.causes,
              ...profileCause,
            ],
          });
        }
        for (const op of ops)
          if (
            !usedOps.has(opNodeOf(contract.sourceId, op.id)) &&
            apiNamesOf(op, generation).has(missing.name)
          )
            notImplemented.set(
              opNodeOf(contract.sourceId, op.id),
              `${impl.controller} implémente ${missing.name} sans méthode pour ${op.operationId ?? op.id}`,
            );
      }
    }
  }
  // Une opération d'un contrat lu par une génération SERVEUR, que ni un endpoint lu ni un endpoint déduit
  // n'expose dans le module : déclarée, non implémentée.
  for (const input of serverInputs)
    for (const op of contractIndex.operations(input.contract)) {
      const opNode = opNodeOf(input.contract.sourceId, op.id);
      if (usedOps.has(opNode) || notImplemented.has(opNode)) continue;
      const route = op.route ?? op.path;
      const exposed = matchEndpoint(
        { endpoints: served.filter((e) => e.sourceId === input.sourceId).map((e) => e.endpoint) },
        op.method,
        route,
      );
      if (!exposed)
        notImplemented.set(
          opNode,
          `aucun contrôleur du module ${input.module} n’implémente ${op.operationId ?? op.id} (${op.method} ${route})`,
        );
    }
  for (const [opNode, why] of notImplemented) {
    const detail = nodes.get(opNode)?.detail;
    if (detail) {
      detail.implemented = false;
      detail.implementation = why;
    }
  }

  // ── Appels entre couches (chemin + méthode HTTP) ──────────────────────────────────────────────
  const layersPresent = new Set(
    input.sources.filter((source) => source.enabled).map((source) => source.layer),
  );
  const downstream = (from: MapLayer): MapLayer[] =>
    from === 'FRONTEND'
      ? [...(layersPresent.has('BFF') ? (['BFF'] as const) : []), 'BACKEND', 'API']
      : from === 'BFF'
        ? ['BACKEND', 'API']
        : ['API'];

  // Les cibles d'une couche : chaque chemin exposé (préfixes justifiés) d'un endpoint ou d'une opération.
  const targetCache = new Map<string, Target[]>();
  const servedByNode = new Map<string, Served>();
  const targetsOf = (layer: MapLayer, variant = DEFAULT_VARIANT, only?: ReadonlySet<string>): Target[] => {
    const key = `${layer}|${variant}|${only ? [...only].join(',') : ''}`;
    const cached = targetCache.get(key);
    if (cached) return cached;
    const list = (layer === 'API' ? contracts : served)
      .filter((entry) => entry.layer === layer && (!only || only.has(entry.sourceId)))
      .flatMap((entry) => {
        servedByNode.set(entry.endpoint.symbolId, entry);
        const own = variant === DEFAULT_VARIANT ? undefined : entry.byVariant?.[variant];
        return (own?.paths ?? entry.exposed ?? [entry.endpoint.path]).map((p): Target => ({
          node: entry.endpoint.symbolId,
          layer,
          kind: layer === 'API' ? 'CONTRACT' : (entry.kind ?? 'SERVED'),
          method: entry.endpoint.method,
          path: p,
          why: own?.why ?? entry.why ?? [],
        }));
      });
    targetCache.set(key, list);
    return list;
  };
  const implementingLayers = (['BFF', 'BACKEND'] as const).filter((l) => layersPresent.has(l));
  /** Les variantes découvertes (profils Spring des sources) : chacune est évaluée séparément. */
  const knownVariants = [
    ...new Set(
      input.facts.flatMap((f) =>
        (f.config?.profiles ?? []).filter((p) => p.how !== 'ACTIVE').map((p) => p.name),
      ),
    ),
  ];
  // ── Destinations : à quelle source mène une adresse (proxy, base d'URL, client), passerelles comprises ──
  const services = servicesOf(
    input.facts.map((f) => ({
      sourceId: f.sourceId,
      name: sourceById.get(f.sourceId)?.name ?? f.sourceId,
      serves: !!f.java,
      ...(f.config ? { config: f.config } : {}),
      ...(f.gateway ? { gateway: f.gateway } : {}),
    })),
  );
  interface Reach {
    /** Le chemin reçu par la destination (après les transformations prouvées). */
    path: string;
    /** Les seules sources admises ; absent : la destination n'est pas établie, rien n'est restreint. */
    only?: ReadonlySet<string>;
    steps: CorrelationStep[];
    causes: Cause[];
    /** Une destination incertaine : une correspondance par le seul chemin reste probable. */
    uncertain: boolean;
  }
  /** Les routes d'une passerelle dans une variante : celles du profil remplacent celles du défaut de même id. */
  const gatewayRoutes = (gw: GatewayFacts, variant: string): GatewayRoute[] => {
    const own = gw.routes.filter((r) => r.variant === variant);
    return [...gw.routes.filter((r) => !r.variant && !own.some((o) => o.id === r.id)), ...own].sort(
      (a, b) => a.order - b.order,
    );
  };
  const reachOf = (
    address: string,
    method: string,
    path: string,
    variant: string,
    upstream?: readonly string[],
    depth = 0,
  ): Reach => {
    const d = destinationOf(address, services, variant, upstream);
    const label = (rule: string): CorrelationStep => ({ kind: 'DESTINATION', label: rule });
    if (d.symbolic)
      return {
        path,
        steps: [label(d.rule)],
        causes: [
          {
            code: 'DESTINATION_SYMBOLIC',
            message: `${d.rule} : la destination n’est connue qu’à l’exécution, elle n’est pas inventée`,
          },
        ],
        uncertain: true,
      };
    if (d.external)
      return {
        path,
        steps: [label(d.rule)],
        causes: [
          {
            code: 'GATEWAY_EXTERNAL',
            message: `${address} (variante ${variant}) : passerelle ou service non fourni parmi les sources analysées ; une correspondance par le seul chemin reste à confirmer`,
          },
        ],
        uncertain: true,
      };
    const gateways = d.sources
      .map((id) => services.find((s) => s.sourceId === id))
      .filter((s): s is ServiceSource => !!s?.gateway);
    if (d.sources.length === 1 && gateways.length === 1 && depth < 3) {
      const gw = gateways[0] as ServiceSource & { gateway: GatewayFacts };
      const routes = gatewayRoutes(gw.gateway, variant).filter((r) => routeMatches(r, method, path));
      const first = routes[0];
      if (!first)
        return {
          path,
          only: new Set(),
          steps: [label(`${d.rule} (passerelle)`)],
          causes: [
            {
              code: 'NO_ENDPOINT',
              message: `aucune route de la passerelle ${gw.name} ne correspond à ${method} ${path} (variante ${variant})`,
            },
          ],
          uncertain: false,
        };
      const routed = routedPath(first, path);
      const step: CorrelationStep = {
        kind: 'GATEWAY',
        label: `${gw.name} (${first.adapter}) route ${first.id}${first.variant ? ` [${first.variant}]` : ''} : ${first.paths.join(', ')}${first.methods.length ? ` ${first.methods.join(',')}` : ''}${routed.steps.length ? ` ; ${routed.steps.join(' ; ')}` : ''} → ${first.uri}${routes.length > 1 ? ` (première de ${String(routes.length)} routes possibles, par ordre)` : ''}`,
        evidence: ev(gw.sourceId, { file: first.file, line: first.line }, 'STATIC_CODE', 'CONFIRMED'),
      };
      const next = reachOf(first.uri, method, routed.path, variant, first.upstream, depth + 1);
      return {
        ...next,
        steps: [label(`${d.rule} (passerelle)`), step, ...next.steps],
        causes: [
          ...(first.dynamic
            ? [{ code: 'PROXY_DYNAMIC' as const, message: `route ${first.id} : ${first.dynamic}` }]
            : []),
          ...next.causes,
        ],
        uncertain: next.uncertain || !!first.dynamic,
      };
    }
    if (d.sources.length > 1)
      return {
        path,
        only: new Set(d.sources),
        steps: [label(d.rule)],
        causes: [
          {
            code: 'MULTIPLE_DESTINATIONS',
            message: `${address} désigne plusieurs sources (${d.sources.join(', ')}) : ${d.rule}`,
          },
        ],
        uncertain: true,
      };
    // Indéterminée (port non déclaré par certaines sources) : rien n'est restreint ni supposé.
    if (d.sources.length === 0) return { path, steps: [label(d.rule)], causes: [], uncertain: false };
    return { path, only: new Set(d.sources), steps: [label(d.rule)], causes: [], uncertain: false };
  };

  /**
   * La destination d'un appel Java dans une variante : la première propriété de son URL (`@Value`, base d'un
   * client) qui vaut une adresse, résolue dans le profil ; une valeur fournie à l'exécution reste symbolique,
   * une clé absente est dite non résolue. Sans propriété, l'origine lue dans le code.
   */
  const javaReach = (
    sourceId: string,
    keys: readonly string[],
    literal: string | undefined,
    method: string,
    path: string,
    variant: string,
    /** La base est une adresse complète (client généré) : sa partie chemin précède le chemin de l'opération. */
    prefixBase = false,
  ): Reach | undefined => {
    const withBase = (url: string): string =>
      prefixBase
        ? normalizePath(`${(/^[a-z]+:\/\/[^/]+(\/[^?#]*)?/i.exec(url)?.[1] ?? '').replace(/\/$/, '')}${path}`)
        : path;
    const config = input.facts.find((f) => f.sourceId === sourceId)?.config;
    const resolver = config ? new ConfigResolver(config) : undefined;
    for (const key of [...new Set(keys)]) {
      const r = resolver?.resolve(key, variant);
      const entry = r?.from[0];
      const where = entry
        ? ` (${entry.file}:${String(entry.line)}${entry.profile ? `, profil ${entry.profile}` : ''})`
        : '';
      const step: CorrelationStep = {
        kind: 'DESTINATION',
        label: `${key} = ${r?.value ?? entry?.value ?? '?'}${where}`,
        ...(entry
          ? { evidence: ev(sourceId, { file: entry.file, line: entry.line }, 'STATIC_CODE', 'CONFIRMED') }
          : {}),
      };
      if (r?.value !== undefined && /^[a-z]+:\/\//i.test(r.value)) {
        const reach = reachOf(r.value, method, withBase(r.value), variant);
        return { ...reach, steps: [step, ...reach.steps] };
      }
      if (r?.runtime.length)
        return {
          path,
          steps: [step],
          causes: [
            {
              code: 'DESTINATION_SYMBOLIC',
              message: `${key} = ${entry?.value ?? ''} : fournie à l’exécution (${r.runtime.join(', ')}), la destination n’est pas inventée`,
            },
          ],
          uncertain: true,
        };
      if (!r || r.unresolved.length)
        return {
          path,
          steps: [
            { kind: 'DESTINATION', label: `${key} : absente de la configuration lue (variante ${variant})` },
          ],
          causes: [
            {
              code: 'PROPERTY_UNRESOLVED',
              message: `la propriété ${key} n’a aucune valeur dans la configuration lue (variante ${variant}) : la destination n’est pas résolue`,
            },
          ],
          uncertain: true,
        };
    }
    if (literal && /^[a-z]+:\/\//i.test(literal)) return reachOf(literal, method, withBase(literal), variant);
    return undefined;
  };
  /** Les variantes d'une source (défaut et profils Spring), pour ses appels sortants. */
  const variantsOf = (sourceId: string): string[] => {
    const config = input.facts.find((f) => f.sourceId === sourceId)?.config;
    return config ? new ConfigResolver(config).variants() : [DEFAULT_VARIANT];
  };
  /** Le résultat d'une destination par variante, dans la forme attendue par la corrélation. */
  const perVariant = (
    sourceId: string,
    reachIn: (variant: string) => Reach | undefined,
  ): {
    main?: Reach;
    only?: ReadonlySet<string>;
    variantOnly?: Record<string, ReadonlySet<string> | undefined>;
    variantCauses?: Record<string, Cause[]>;
    variantSteps?: Record<string, string>;
  } => {
    const main = reachIn(DEFAULT_VARIANT);
    const variantOnly: Record<string, ReadonlySet<string> | undefined> = {};
    const variantCauses: Record<string, Cause[]> = {};
    const variantSteps: Record<string, string> = {};
    for (const v of variantsOf(sourceId)) {
      if (v === DEFAULT_VARIANT) continue;
      const r = reachIn(v);
      const same =
        r?.only === main?.only ||
        (!!r?.only &&
          !!main?.only &&
          r.only.size === main.only.size &&
          [...r.only].every((x) => main.only?.has(x)));
      variantOnly[v] = same ? main?.only : r?.only;
      if (r?.causes.length) variantCauses[v] = r.causes;
      if (r?.steps.length) variantSteps[v] = r.steps.map((st) => st.label).join(' → ');
    }
    return {
      ...(main ? { main } : {}),
      ...(main?.only ? { only: main.only } : {}),
      ...(Object.keys(variantOnly).length ? { variantOnly } : {}),
      ...(Object.keys(variantCauses).length ? { variantCauses } : {}),
      ...(Object.keys(variantSteps).length ? { variantSteps } : {}),
    };
  };

  /**
   * La corrélation d'un appel avec les couches en aval, dans l'ordre : la première couche qui en démontre
   * une cible l'emporte ; les causes des autres sont gardées. Le résultat est noté dans `correlations`.
   */
  const correlateCall = (
    from: string,
    call: {
      method: string;
      path: string;
      baseUnknown: boolean;
      /** Le chemin de l'appel dans une variante qui le change (base d'URL propre à un environnement). */
      variants?: Record<string, string>;
      /** Les sources où la destination est démontrée (passerelle, base d'un client) : seules cibles admises. */
      only?: ReadonlySet<string>;
      /** La destination propre à une variante (proxy de la configuration, base d'URL du profil). */
      variantOnly?: Record<string, ReadonlySet<string> | undefined>;
      /** Les causes propres à une variante (destination symbolique, passerelle externe…). */
      variantCauses?: Record<string, Cause[]>;
      /** Les étapes propres à une variante (proxy, passerelle, destination) : montrées avec son issue. */
      variantSteps?: Record<string, string>;
    },
    layers: readonly MapLayer[],
    steps: CorrelationStep[],
    extra: Cause[] = [],
    inferredCall = false,
  ): { match: Match; found?: { target: Served; how: 'EXACT' | 'SUFFIX'; path: string } } => {
    const causes: Cause[] = [...extra];
    const candidates: MapCorrelation['candidates'] = [];
    let chosen: Match | undefined;
    for (const layer of layers) {
      const match = matchCall(call, targetsOf(layer, DEFAULT_VARIANT, call.only));
      candidates.push(...match.candidates);
      causes.push(...match.causes);
      if (match.target) {
        chosen = match;
        break;
      }
    }
    const target = chosen?.target;
    const entry = target ? servedByNode.get(target.node) : undefined;
    const chain = target ? derivation.get(target.node) : undefined;
    if (target?.kind === 'CONTRACT' && implementingLayers.length > 0)
      causes.push({
        code: 'CONTRACT_NOT_IMPLEMENTED',
        message:
          notImplemented.get(target.node) ??
          `l’opération ${target.method} ${target.path} est décrite par le contrat, mais aucun endpoint des sources ${implementingLayers.join(', ')} analysées ne l’expose`,
      });
    if (!target && causes.length === 0)
      causes.push(
        implementingLayers.length === 0 && !layers.includes('API')
          ? {
              code: 'LAYER_MISSING',
              message: `aucune source ${layers.join(', ')} n’est analysée : l’appel ne peut pas être suivi`,
            }
          : {
              code: 'NO_ENDPOINT',
              message: `aucun endpoint ni opération de contrat ne correspond à ${call.method} ${call.path}`,
            },
      );
    if (chain) causes.push(...chain.causes);
    const status: MapCorrelation['status'] = !target
      ? causes.some((c) => c.code === 'LAYER_MISSING')
        ? 'BLOCKED'
        : 'UNDEMONSTRATED'
      : target.kind === 'CONTRACT' && implementingLayers.length > 0
        ? 'UNDEMONSTRATED'
        : inferredCall && chosen?.status === 'CONFIRMED'
          ? 'PROBABLE'
          : (chosen?.status ?? 'UNDEMONSTRATED');
    // Les variantes (profils, configurations du frontal) dont l'issue diffère de celle du défaut.
    const statusOf = (m: Match | undefined): MapCorrelation['status'] =>
      !m?.target
        ? 'UNDEMONSTRATED'
        : m.target.kind === 'CONTRACT' && implementingLayers.length > 0
          ? 'UNDEMONSTRATED'
          : inferredCall && m.status === 'CONFIRMED'
            ? 'PROBABLE'
            : m.status;
    const variantResults: NonNullable<MapCorrelation['variants']> = [];
    for (const v of [
      ...new Set([
        ...knownVariants,
        ...Object.keys(call.variants ?? {}),
        ...Object.keys(call.variantOnly ?? {}),
      ]),
    ]) {
      const p = call.variants?.[v] ?? call.path;
      const vOnly = call.variantOnly && v in call.variantOnly ? call.variantOnly[v] : call.only;
      const vc: Cause[] = [...(call.variantCauses?.[v] ?? [])];
      let m: Match | undefined;
      for (const layer of layers) {
        const r = matchCall(
          { ...call, path: p, baseUnknown: p.startsWith('{base}') },
          targetsOf(layer, v, vOnly),
        );
        vc.push(...r.causes);
        if (r.target) {
          m = r;
          break;
        }
      }
      const own = call.variantCauses?.[v] ?? [];
      const raw = statusOf(m);
      // Une destination incertaine dans cette variante : une correspondance par le seul chemin reste probable.
      const st = own.length && raw === 'CONFIRMED' ? 'PROBABLE' : raw;
      if (
        m?.target?.node === target?.node &&
        m?.target?.path === target?.path &&
        st === status &&
        p === call.path &&
        vOnly === call.only
      )
        continue;
      variantResults.push({
        variant: v,
        path: p,
        ...(call.variantSteps?.[v] ? { chain: call.variantSteps[v] } : {}),
        status: st,
        ...(m?.target ? { target: m.target.node, exposed: m.target.path } : {}),
        causes: dedupeCauses(
          vc.length
            ? vc
            : m?.target
              ? []
              : [
                  {
                    code: 'NO_ENDPOINT',
                    message: `aucun endpoint ne correspond à ${call.method} ${p} dans la variante ${v}`,
                  },
                ],
        ),
      });
    }
    // Incohérente seulement si l'issue change (statut ou cible) : un chemin différent sans effet n'en est pas une.
    if (variantResults.some((r) => r.status !== status || r.target !== target?.node))
      causes.push({
        code: 'ENVIRONMENT_INCONSISTENT',
        message: `l’issue change selon la variante (${variantResults.map((r) => `${r.variant} : ${r.status}${r.target ? ` → ${r.target}` : ''}`).join(', ')}) ; le profil actif n’est pas connu`,
      });
    // Une source examinée lue en partie : l'absence de cible n'est pas une preuve.
    const examinedSources = input.sources.filter((s) => s.enabled && layers.includes(s.layer));
    const limits = examinedSources.flatMap((s) =>
      (input.facts.find((f) => f.sourceId === s.id)?.partial ?? []).map((l) => `${s.name} : ${l}`),
    );
    if (!target && limits.length)
      causes.push({
        code: 'SOURCE_PARTIAL',
        message: `lecture partielle (${limits.join(' ; ')}) : la cible peut se trouver dans la partie non lue`,
      });
    const diagnostic: MapCorrelation['diagnostic'] =
      status === 'CONFIRMED'
        ? undefined
        : {
            start: from,
            lastDemonstrated:
              (target ? steps : steps.filter((st) => st.kind !== 'ENDPOINT')).at(-1)?.label ?? from,
            sought: `${call.method} ${call.path} servi par ${layers.join(', ')}${call.only ? ` (destination : ${[...call.only].join(', ') || 'aucune source'})` : ''}`,
            examined: examinedSources.map(
              (s) =>
                `${s.name} (${s.layer}, ${String(targetsOf(s.layer, DEFAULT_VARIANT, call.only).filter((t) => servedByNode.get(t.node)?.sourceId === s.id).length)} cibles)`,
            ),
            // Les contrats (API) sont facultatifs : leur absence n'est citée que si rien d'autre n'a été examiné.
            missing: layers.filter(
              (l) =>
                !examinedSources.some((s) => s.layer === l) && (l !== 'API' || examinedSources.length === 0),
            ),
            limits,
            suggestions: [...new Set(dedupeCauses(causes).flatMap((c) => SUGGESTIONS[c.code] ?? []))],
          };
    correlations.push({
      from,
      method: call.method,
      path: call.path,
      status,
      ...(diagnostic ? { diagnostic } : {}),
      ...(target ? { target: target.node } : {}),
      ...(variantResults.length ? { variants: variantResults } : {}),
      candidates: candidates.slice(0, 12),
      causes: dedupeCauses(causes),
      steps: [
        ...steps,
        ...(chain?.steps ?? []),
        // Une route héritée : le type parent qui la déclare (interface générée versionnée, classe de base).
        ...(target && typeof nodes.get(target.node)?.detail.declaredBy === 'string'
          ? [
              {
                kind: 'INTERFACE' as const,
                label: `route déclarée par ${String(nodes.get(target.node)?.detail.declaredBy)}, exposée par ${String(nodes.get(target.node)?.detail.controller)} (${String(nodes.get(target.node)?.detail.handler)})`,
                ...(nodes.get(target.node)?.evidence[1]
                  ? { evidence: nodes.get(target.node)?.evidence[1] }
                  : {}),
              },
            ]
          : []),
        ...(target
          ? [
              {
                kind: target.kind === 'CONTRACT' ? ('CONTRACT' as const) : ('ENDPOINT' as const),
                label: `${target.method} ${target.path}${target.why.length ? ` — ${target.why.join(' ; ')}` : ''}`,
                node: target.node,
              },
            ]
          : []),
      ],
    });
    return {
      match: chosen ?? { status: 'UNDEMONSTRATED', candidates, causes },
      ...(target && entry && chosen?.how
        ? { found: { target: entry, how: chosen.how, path: target.path } }
        : {}),
    };
  };
  const matchText = (match: Match, method: string, p: string): string => {
    const first = match.causes.find((c) => c.code !== 'PREFIX_UNKNOWN');
    if (!first) return `aucun endpoint ne correspond à ${method} ${p}`;
    return first.code === 'AMBIGUOUS' ? `correspondance ambiguë : ${first.message}` : first.message;
  };

  /** Le corps envoyé vers un endpoint : champ par champ, par le nom JSON (liaison Jackson). */
  const bindBody = (
    fromFields: { id: string; key: string }[],
    target: Served,
    confidence: MapConfidence,
    why: string,
    evidence: Evidence[],
  ): void => {
    if (!target.requestBody) return;
    for (const field of fromFields) {
      const to = jsonField(target.sourceId, target.requestBody, field.key);
      if (to)
        edge(
          field.id,
          to,
          'SENDS',
          confidence,
          `${why} : propriété « ${field.key} » du corps de ${target.endpoint.method} ${target.endpoint.path}`,
          evidence,
        );
    }
  };

  for (const facts of input.facts) {
    const src = facts.sourceId;
    if (facts.ui) {
      const ui = facts.ui;
      // Champ → appel (flux de données), composant → appel.
      for (const flow of ui.flows) {
        if (!flow.field || !flow.call) continue;
        const field = `FIELD:${src}:${flow.field}`;
        const call = `METHOD:${src}:${flow.call}`;
        edge(
          field,
          call,
          'SENDS',
          flow.resolved ? 'CONFIRMED' : 'PROBABLE',
          flow.resolved
            ? `flux de données résolu : ${flow.requestProperty ?? flow.field} est envoyé`
            : `flux de données non résolu${flow.reason ? ` (${flow.reason})` : ''}`,
          [ev(src, flow.loc, 'STATIC_CODE', flow.resolved ? 'CONFIRMED' : 'PROBABLE')],
        );
        const component = flow.field.split('#')[0] ?? '';
        edge(
          `COMPONENT:${src}:${component}`,
          call,
          'CALLS',
          flow.resolved ? 'CONFIRMED' : 'PROBABLE',
          'le composant envoie son formulaire par cet appel',
          [ev(src, flow.loc, 'STATIC_CODE', flow.resolved ? 'CONFIRMED' : 'PROBABLE')],
        );
        const callFacts = ui.calls.find((entry) => entry.id === flow.call);
        const dtoField =
          flow.dtoProperty && callFacts?.bodyType
            ? `${callFacts.bodyType}.${last(flow.dtoProperty)}`
            : undefined;
        if (dtoField)
          edge(
            field,
            `FIELD:${src}:${dtoField}`,
            'TRANSFORMS',
            flow.resolved ? 'CONFIRMED' : 'PROBABLE',
            `affecté à ${dtoField}`,
            [ev(src, flow.loc, 'STATIC_CODE', flow.resolved ? 'CONFIRMED' : 'PROBABLE')],
          );
      }
      for (const read of ui.reads)
        if (read.field && read.call) {
          const component = read.field.split('#')[0] ?? '';
          edge(
            `COMPONENT:${src}:${component}`,
            `METHOD:${src}:${read.call}`,
            'CALLS',
            'CONFIRMED',
            'le composant lit la valeur initiale de son formulaire par cet appel',
            [ev(src, read.loc, 'STATIC_CODE', 'CONFIRMED')],
          );
          edge(
            `METHOD:${src}:${read.call}`,
            `FIELD:${src}:${read.field}`,
            'READS',
            'CONFIRMED',
            `valeur initiale lue dans la réponse${read.responseProperty ? ` (${read.responseProperty})` : ''}`,
            [ev(src, read.loc, 'STATIC_CODE', 'CONFIRMED')],
          );
        }
      // Appel frontal → endpoint servi (BFF, backend), déduit, ou opération du contrat : corrélation.
      for (const call of ui.calls) {
        const id = `METHOD:${src}:${call.id}`;
        const callDetail = nodes.get(id)?.detail;
        const callStep: CorrelationStep = {
          kind: 'CALL',
          label: `${call.method} ${call.path ?? call.expression ?? ''}${call.via ? ` (par ${call.via})` : ''}`,
          node: id,
          evidence: ev(src, call.loc, 'STATIC_CODE', 'CONFIRMED'),
        };
        if (!call.path) {
          if (call.unresolved)
            correlations.push({
              from: id,
              method: call.method,
              path: call.expression ?? '',
              status: 'UNDEMONSTRATED',
              candidates: [],
              causes: [
                {
                  code: 'DYNAMIC_URL',
                  message: `${call.unresolved}${call.expression ? ` (${call.expression})` : ''}`,
                },
              ],
              steps: [callStep],
            });
          continue;
        }
        // Par variante du frontal (défaut, configurations d'angular.json) : la base de l'environnement, la règle
        // du proxy de cette variante (réécriture, règle dynamique), puis la destination (passerelle comprise).
        const frontVariants = [DEFAULT_VARIANT, ...(ui.variants ?? []).map((v) => v.name)];
        interface FrontRoute {
          path: string;
          reach?: Reach;
          proxy?: NonNullable<typeof ui.proxies>[number];
          rewritten?: string;
          steps: CorrelationStep[];
          causes: Cause[];
        }
        const frontRoute = (variant: string): FrontRoute => {
          let path = call.path ?? '';
          let address: string | undefined;
          const steps: CorrelationStep[] = [];
          // La base lue dans le fichier environment de la variante (remplacement d'angular.json).
          if (call.baseKey && path.startsWith('{base}')) {
            const entry = ui.environment?.find((e) => e.key === call.baseKey);
            const defaultFile =
              (ui.variants ?? []).flatMap((v) => v.replacements.map((r) => r.replace))[0] ??
              entry?.values.find((v) => /(^|\/)environment\.ts$/.test(v.file))?.file;
            const file =
              (ui.variants ?? [])
                .find((v) => v.name === variant)
                ?.replacements.find((r) => r.replace === defaultFile)?.with ?? defaultFile;
            const value = entry?.values.find((v) => v.file === file)?.value;
            if (value !== undefined) {
              const rest = path.slice('{base}'.length);
              const abs = /^([a-z]+:\/\/[^/]+)(\/.*)?$/i.exec(value);
              address = abs?.[1];
              path = `${(abs ? (abs[2] ?? '') : value).replace(/\/$/, '')}${rest}`.replace(/\/{2,}/g, '/');
              steps.push({
                kind: 'BASE',
                label: `${call.baseKey} = '${value}' (${file ?? ''}, variante ${variant})`,
                ...(file ? { evidence: ev(src, { file, line: 1 }, 'STATIC_CODE', 'CONFIRMED') } : {}),
              });
            }
          }
          if (address) {
            const reach = reachOf(address, call.method, path, variant);
            return { path: reach.path, reach, steps: [...steps, ...reach.steps], causes: reach.causes };
          }
          // Le proxy de développement : celui de la variante, sinon celui du défaut ; la règle au plus long contexte.
          const local = path.replace(/\/{2,}/g, '/');
          const own = (ui.proxies ?? []).some((p) => p.variant === variant);
          const rules = (ui.proxies ?? [])
            .filter((p) => (p.variant ?? DEFAULT_VARIANT) === (own ? variant : DEFAULT_VARIANT))
            .filter(
              (p) =>
                local === p.context ||
                local.startsWith(`${p.context.replace(/\/$/, '')}/`) ||
                p.context === '/',
            )
            .sort((a, b) => b.context.length - a.context.length);
          const proxy = rules[0];
          if (!proxy) return { path, steps, causes: [] };
          const proxyEv = ev(src, { file: proxy.file, line: proxy.line }, 'STATIC_CODE', 'CONFIRMED');
          if (proxy.dynamic)
            return {
              path,
              proxy,
              steps: [
                ...steps,
                {
                  kind: 'PROXY',
                  label: `${proxy.file} « ${proxy.context} » : ${proxy.dynamic}`,
                  evidence: proxyEv,
                },
              ],
              causes: [
                {
                  code: 'PROXY_DYNAMIC',
                  message: `règle « ${proxy.context} » de ${proxy.file} non interprétable sans exécution (${proxy.dynamic}) : la destination n’est pas déduite`,
                },
              ],
            };
          let rewritten: string | undefined;
          if (proxy.rewrite)
            try {
              rewritten = local.replace(new RegExp(proxy.rewrite.pattern), proxy.rewrite.replacement) || '/';
            } catch {
              rewritten = undefined;
            }
          const sent = rewritten ?? local;
          const proxyStep: CorrelationStep = {
            kind: 'PROXY',
            label: `${proxy.file} « ${proxy.context} »${proxy.target ? ` → ${proxy.target}` : ''}${rewritten ? ` ; réécriture « ${proxy.rewrite?.pattern ?? ''} » → « ${proxy.rewrite?.replacement ?? ''} » : ${rewritten}` : ''}`,
            evidence: proxyEv,
          };
          if (!proxy.target)
            return {
              path: sent,
              proxy,
              ...(rewritten ? { rewritten } : {}),
              steps: [...steps, proxyStep],
              causes: [],
            };
          const reach = reachOf(proxy.target, call.method, sent, variant);
          return {
            path: reach.path,
            reach,
            proxy,
            ...(rewritten ? { rewritten } : {}),
            steps: [...steps, proxyStep, ...reach.steps],
            causes: reach.causes,
          };
        };
        const routes = new Map(frontVariants.map((v) => [v, frontRoute(v)]));
        const main = routes.get(DEFAULT_VARIANT) ?? frontRoute(DEFAULT_VARIANT);
        const proxy = main.proxy;
        const baseSteps: CorrelationStep[] = [
          callStep,
          ...(call.base ? [{ kind: 'BASE' as const, label: call.base }] : []),
        ];
        const sameSet = (a?: ReadonlySet<string>, b?: ReadonlySet<string>): boolean =>
          a === b || (!!a && !!b && a.size === b.size && [...a].every((x) => b.has(x)));
        const variantPaths: Record<string, string> = {};
        const variantOnly: Record<string, ReadonlySet<string> | undefined> = {};
        const variantCauses: Record<string, Cause[]> = {};
        const variantSteps: Record<string, string> = {};
        for (const [v, r] of routes) {
          if (v === DEFAULT_VARIANT) continue;
          if (r.path !== main.path) variantPaths[v] = r.path;
          variantOnly[v] = sameSet(r.reach?.only, main.reach?.only) ? main.reach?.only : r.reach?.only;
          if (r.causes.length) variantCauses[v] = r.causes;
          if (r.steps.length) variantSteps[v] = r.steps.map((st) => st.label).join(' → ');
        }
        const callFor = (path: string) => ({
          method: call.method,
          path,
          baseUnknown: path.startsWith('{base}'),
          ...(main.reach?.only ? { only: main.reach.only } : {}),
          ...(Object.keys(variantPaths).length ? { variants: variantPaths } : {}),
          ...(Object.keys(variantOnly).length ? { variantOnly } : {}),
          ...(Object.keys(variantCauses).length ? { variantCauses } : {}),
          ...(Object.keys(variantSteps).length ? { variantSteps } : {}),
        });
        let result = correlateCall(
          id,
          callFor(main.path),
          downstream('FRONTEND'),
          [...baseSteps, ...main.steps],
          main.causes,
          main.reach?.uncertain ?? false,
        );
        const usedRewrite = result.found !== undefined && main.rewritten !== undefined;
        // Sans destination établie, une réécriture qui ne mène nulle part n'empêche pas la comparaison directe.
        if (!result.found && main.rewritten !== undefined && !main.reach) {
          correlations.pop();
          result = correlateCall(
            id,
            { ...callFor(call.path), only: undefined },
            downstream('FRONTEND'),
            baseSteps,
          );
        }
        if (!result.found) {
          if (callDetail) callDetail.match = matchText(result.match, call.method, call.path);
          continue;
        }
        const found = result.found;
        const confidence: MapConfidence =
          found.how === 'EXACT' && found.target.kind !== 'INFERRED' ? 'CONFIRMED' : 'PROBABLE';
        const why =
          found.target.kind === 'INFERRED'
            ? `${call.method} ${call.path} correspond à l’endpoint déduit ${found.target.endpoint.method} ${found.path} (route du contrat, interface générée absente)`
            : found.how === 'EXACT'
              ? `méthode et chemin identiques (${call.method} ${call.path})${found.path !== found.target.endpoint.path ? ` ; chemin exposé ${found.path}` : ''}`
              : `adresse de base non résolue : ${call.path} correspond à ${found.target.endpoint.path} par la fin du chemin`;
        edge(
          id,
          found.target.endpoint.symbolId,
          'CALLS',
          confidence,
          `${why}${call.base ? ` ; base : ${call.base}` : ''}${
            usedRewrite && proxy?.rewrite
              ? ` ; réécriture du proxy ${proxy.file} « ${proxy.rewrite.pattern} » → « ${proxy.rewrite.replacement} »`
              : ''
          }`,
          [ev(src, call.loc, 'STATIC_CODE', confidence)],
        );
        const sent = ui.flows
          .filter((flow) => flow.call === call.id && flow.field)
          .map((flow) => ({
            id: `FIELD:${src}:${flow.field ?? ''}`,
            key: last(flow.dtoProperty ?? flow.requestProperty ?? flow.field ?? ''),
            resolved: flow.resolved,
          }));
        for (const field of sent)
          bindBody(
            [field],
            found.target,
            weakest(confidence, field.resolved ? 'CONFIRMED' : 'PROBABLE'),
            'liaison JSON par nom (Jackson)',
            [ev(src, call.loc, 'STATIC_CODE', confidence)],
          );
      }
      // Déclenchement (appel, next(), traitement de flux, @Output) → CALLS ; données (flux calculé, réponse
      // poussée dans un flux) → DEPENDS_ON, du flux vers ce dont il dépend.
      const kindOf = new Map((ui.symbols ?? []).map((sym) => [sym.id, sym.stream ? 'STREAM' : 'METHOD']));
      const symbolNode = (id: string): string => `${kindOf.get(id) ?? 'METHOD'}:${src}:${id}`;
      for (const l of ui.links ?? []) {
        const evidence = [ev(src, l.loc, 'STATIC_CODE', l.confidence, l.kind)];
        const flow: MapEdge['detail'] =
          l.condition || l.async || l.data || l.context || (l.timing && l.timing !== 'DIRECT')
            ? {
                ...(l.condition ? { condition: l.condition } : {}),
                ...(l.async ? { async: l.async } : {}),
                ...(l.data ? { data: l.data } : {}),
                ...(l.context ? { context: l.context } : {}),
                ...(l.timing ? { timing: l.timing } : {}),
                ...(l.concurrent ? { concurrent: true } : {}),
                ...(l.cancellable ? { cancellable: true } : {}),
              }
            : undefined;
        if (l.kind === 'DERIVES')
          edge(symbolNode(l.from), symbolNode(l.to), 'DEPENDS_ON', l.confidence, l.reason, evidence);
        else if (l.kind === 'FEEDS')
          edge(symbolNode(l.to), symbolNode(l.from), 'DEPENDS_ON', l.confidence, l.reason, evidence);
        else edge(symbolNode(l.from), symbolNode(l.to), 'CALLS', l.confidence, l.reason, evidence, flow);
      }
      // L'écran fait ce que font ses méthodes : appelées par le gabarit ou le cycle de vie (sûr), sinon
      // seulement en interne (probable).
      for (const sym of ui.symbols ?? [])
        if (sym.entry)
          edge(
            `COMPONENT:${src}:${sym.owner}`,
            `METHOD:${src}:${sym.id}`,
            'CALLS',
            sym.entry === 'INTERNAL' ? 'PROBABLE' : 'CONFIRMED',
            sym.entry === 'TEMPLATE'
              ? `${sym.name}() est appelée par le gabarit`
              : sym.entry === 'LIFECYCLE'
                ? `${sym.name}() est exécutée au cycle de vie du composant`
                : `${sym.name}() n’est appelée par aucun gabarit ni cycle de vie lus`,
            [ev(src, sym.loc, 'STATIC_CODE', sym.entry === 'INTERNAL' ? 'PROBABLE' : 'CONFIRMED')],
          );
    }
    if (facts.java) {
      const layer: MapLayer = (sourceById.get(src)?.layer ?? facts.layer) === 'BFF' ? 'BFF' : 'BACKEND';
      for (const out of facts.java.outgoing) {
        if (!out.path || !out.method) continue;
        const outPath = out.path;
        const outMethod = out.method;
        // La destination par variante : la base d'URL (`@Value`) résolue dans chaque profil de la source.
        const dest = perVariant(src, (v) =>
          javaReach(src, out.properties ?? [], out.origin, outMethod, outPath, v),
        );
        const result = correlateCall(
          `METHOD:${out.from}`,
          {
            method: out.method,
            path: dest.main?.path ?? out.path,
            baseUnknown: /^\{/.test(out.path),
            ...(dest.only ? { only: dest.only } : {}),
            ...(dest.variantOnly ? { variantOnly: dest.variantOnly } : {}),
            ...(dest.variantCauses ? { variantCauses: dest.variantCauses } : {}),
            ...(dest.variantSteps ? { variantSteps: dest.variantSteps } : {}),
          },
          downstream(layer),
          [
            {
              kind: 'OUTGOING',
              label: `${out.method} ${out.path}${out.client ? ` (${out.client})` : ''}`,
              node: `METHOD:${out.from}`,
              evidence: ev(src, out.loc, 'STATIC_CODE', 'CONFIRMED'),
            },
            ...(dest.main?.steps ?? []),
          ],
          dest.main?.causes ?? [],
          dest.main?.uncertain ?? false,
        );
        const found = result.found;
        if (!found) continue;
        const confidence: MapConfidence =
          out.status === 'STATICALLY_RESOLVED' && found.how === 'EXACT' ? 'CONFIRMED' : 'PROBABLE';
        edge(
          `METHOD:${out.from}`,
          found.target.endpoint.symbolId,
          'CALLS',
          confidence,
          out.status === 'STATICALLY_RESOLVED'
            ? `appel HTTP sortant ${out.method} ${out.path}`
            : `appel HTTP sortant reconstruit (${out.method} ${out.path})`,
          [ev(src, out.loc, 'STATIC_CODE', confidence)],
        );
        // Le corps envoyé : son type est montré par le code → liaison JSON ; sinon, rien n'est supposé.
        const body = out.bodyType
          ? javaClasses.get(out.bodyType)?.find((entry) => entry.sourceId === src)?.cls
          : undefined;
        if (body)
          bindBody(
            body.fields.map((field) => ({
              id: `FIELD:${src}:${body.name}.${field.name}`,
              key: field.jsonName ?? field.name,
            })),
            found.target,
            confidence,
            'liaison JSON par nom (Jackson) du corps envoyé',
            [ev(src, out.loc, 'STATIC_CODE', confidence)],
          );
        // La réponse lue : son type est montré par le code (`Type.class`) → chaque propriété de même nom
        // JSON est pilotée par celle du type rendu par l'endpoint appelé (désérialisation Jackson).
        const returned = nodes.get(found.target.endpoint.symbolId)?.detail.returns;
        const reply = out.responseType
          ? javaClasses.get(out.responseType)?.find((entry) => entry.sourceId === src)?.cls
          : undefined;
        if (reply && typeof returned === 'string')
          for (const field of reply.fields) {
            const from = fieldNode(src, reply.name, field.name);
            const to = jsonField(found.target.sourceId, returned, field.jsonName ?? field.name);
            if (from && to)
              edge(
                from,
                to,
                'CONTROLLED_BY',
                weakest(confidence, 'PROBABLE'),
                `réponse JSON de ${out.method} ${out.path} lue en ${reply.name} : propriété « ${field.jsonName ?? field.name} » de ${returned}`,
                [ev(src, out.loc, 'STATIC_CODE', weakest(confidence, 'PROBABLE'))],
              );
          }
      }
      // Les appels par un client généré (type importé, absent des sources) : la génération cliente du module
      // qui produit ce package, son contrat d'entrée, l'opération de ce nom → l'appel HTTP qu'elle décrit.
      for (const cc of facts.java.clients ?? []) {
        const owner = contractIndex.moduleOf(src, cc.loc.file);
        const pkg = packageOf(cc.qualified);
        const generation = owner?.module.generations.find(
          (g) => g.apiPackage === pkg && sideOf(g) === 'CLIENT',
        );
        const from = `METHOD:${cc.from}`;
        const callStep: CorrelationStep = {
          kind: 'OUTGOING',
          label: `${cc.type}.${cc.operation}() (${cc.qualified})`,
          node: from,
          evidence: ev(src, cc.loc, 'STATIC_CODE', 'CONFIRMED'),
        };
        // Un type absent qu'aucune génération cliente ne produit n'est pas forcément un client HTTP : rien n'est noté.
        if (!owner || !generation) continue;
        const resolved = contractIndex.resolveSpec(owner.sourceId, owner.module, generation);
        const genEv = ev(
          owner.sourceId,
          { file: owner.module.file, line: generation.line },
          'STATIC_CODE',
          'CONFIRMED',
        );
        const steps: CorrelationStep[] = [
          callStep,
          {
            kind: 'GENERATION',
            label: `génération cliente ${generation.execution ?? ''} (${generation.generator ?? ''}${generation.library ? `/${generation.library}` : ''}, apiPackage ${pkg})`,
            evidence: genEv,
          },
          ...resolved.steps.map((st): CorrelationStep => ({ kind: 'CONTRACT', label: st.label })),
        ];
        const contract = resolved.contract;
        const ops = contract
          ? operationsFor(contractIndex.operations(contract), generation, cc.type, cc.operation)
          : [];
        const op = ops.length === 1 ? ops[0] : undefined;
        if (!contract || !op) {
          correlations.push({
            from,
            method: '',
            path: '',
            status: contract ? 'UNDEMONSTRATED' : 'BLOCKED',
            candidates: [],
            causes: dedupeCauses([
              ...resolved.causes,
              {
                code: 'BACKEND_CALL_UNRESOLVED',
                message: contract
                  ? `${ops.length > 1 ? `${String(ops.length)} opérations` : 'aucune opération'} du contrat ${contract.doc.file} ne correspond à ${cc.type}.${cc.operation}()`
                  : `le contrat du client ${cc.type} n’est pas établi`,
              },
            ]),
            steps,
          });
          continue;
        }
        const route = op.route ?? op.path;
        steps.push({
          kind: 'CONTRACT',
          label: `${op.method} ${route} (operationId ${op.operationId ?? ''}, ${contract.doc.title ?? contract.doc.file} ${contract.doc.version ?? ''})`,
          node: opNodeOf(contract.sourceId, op.id),
        });
        // La base du client réglée par un bean (`setBasePath`) : la destination par variante ; sans bean lu,
        // l'adresse est réglée à l'exécution : la route est comparée seule, puis en suffixe.
        const bases = facts.java.clientBases ?? [];
        const clientReach = (v: string): Reach | undefined => {
          const own = bases.filter((b) => b.profile === v);
          const applicable = own.length ? own : bases.filter((b) => !b.profile);
          const reaches = applicable.flatMap((b) => {
            const r = javaReach(src, b.property ? [b.property] : [], b.value, op.method, route, v, true);
            if (!r) return [];
            const beanStep: CorrelationStep = {
              kind: 'DESTINATION',
              label: `${b.type} réglé par un bean : base ${b.property ? `\${${b.property}}` : (b.value ?? '')}${b.profile ? ` (@Profile ${b.profile})` : ''}${b.condition ? ` (@ConditionalOnProperty(${b.condition}), condition non évaluée)` : ''}`,
              evidence: ev(src, b.loc, 'STATIC_CODE', 'CONFIRMED'),
            };
            return [{ ...r, steps: [beanStep, ...r.steps], uncertain: r.uncertain || !!b.condition }];
          });
          if (reaches.length <= 1) return reaches[0];
          const all = new Set(reaches.flatMap((r) => [...(r.only ?? [])]));
          return {
            path: route,
            ...(all.size ? { only: all } : {}),
            steps: reaches.flatMap((r) => r.steps),
            causes: [
              {
                code: 'MULTIPLE_DESTINATIONS',
                message: `${String(reaches.length)} bases de client réglées par des beans dans la variante ${v} : le client utilisé par ${cc.type} n’est pas établi`,
              },
            ],
            uncertain: true,
          };
        };
        const dest = perVariant(src, clientReach);
        const layers = downstream(layer).filter((l) => l !== 'API');
        let result = correlateCall(
          from,
          {
            method: op.method,
            path: dest.main?.path ?? route,
            baseUnknown: false,
            ...(dest.only ? { only: dest.only } : {}),
            ...(dest.variantOnly ? { variantOnly: dest.variantOnly } : {}),
            ...(dest.variantCauses ? { variantCauses: dest.variantCauses } : {}),
            ...(dest.variantSteps ? { variantSteps: dest.variantSteps } : {}),
          },
          layers,
          [...steps, ...(dest.main?.steps ?? [])],
          [...resolved.causes, ...(dest.main?.causes ?? [])],
          true,
        );
        if (!result.found && !dest.only) {
          correlations.pop();
          result = correlateCall(
            from,
            { method: op.method, path: `{base}${route}`, baseUnknown: true },
            layers,
            steps,
            resolved.causes,
            true,
          );
        }
        const found = result.found;
        if (!found) continue;
        edge(
          from,
          found.target.endpoint.symbolId,
          'CALLS',
          'PROBABLE',
          `appel par le client généré ${cc.type}.${cc.operation}() : ${op.method} ${route} (contrat ${contract.doc.file}${contract.doc.version ? ` ${contract.doc.version}` : ''}, génération ${generation.execution ?? generation.generator ?? ''})`,
          [ev(src, cc.loc, 'STATIC_CODE', 'PROBABLE'), ev(contract.sourceId, op.loc, 'OPENAPI', 'CONFIRMED')],
        );
        // Versions : le contrat du client et celui que la cible déclare (même titre) sont-ils compatibles ?
        const own = contractIndex.documents.find(
          (d) =>
            d.sourceId === found.target.sourceId &&
            d.doc.title !== undefined &&
            d.doc.title === contract.doc.title,
        );
        const latest = correlations[correlations.length - 1];
        if (own && latest && own.doc.version !== contract.doc.version) {
          const theirs = contractIndex
            .operations(own)
            .find((o) => o.method === op.method && normalizePath(o.route ?? o.path) === normalizePath(route));
          latest.causes.push(
            theirs
              ? {
                  code: 'CONTRACT_VERSION_UNKNOWN',
                  message: `versions différentes (${contract.doc.version ?? '?'} côté client, ${own.doc.version ?? '?'} côté serveur) : l’opération ${op.method} ${route} existe dans les deux`,
                }
              : {
                  code: 'CONTRACT_VERSION_UNKNOWN',
                  message: `versions différentes (${contract.doc.version ?? '?'} côté client, ${own.doc.version ?? '?'} côté serveur) : l’opération ${op.method} ${route} est absente du contrat du serveur`,
                },
          );
        }
      }
    }
  }

  // ── Structure conditionnelle : conteneurs, boutons, conditions, décisions ────────────────────────
  for (const facts of input.facts) {
    const src = facts.sourceId;
    const ui = facts.ui;
    if (ui) {
      const elementNode = (id: string, kind: 'CONTAINER' | 'BUTTON'): string => `${kind}:${src}:${id}`;
      const kinds = new Map((ui.elements ?? []).map((el) => [el.id, el.kind]));
      for (const el of ui.elements ?? [])
        node(
          elementNode(el.id, el.kind),
          el.kind,
          'FRONTEND',
          el.name,
          ev(
            src,
            el.loc,
            'STATIC_CODE',
            'CONFIRMED',
            `${el.kind === 'BUTTON' ? 'bouton' : el.tab ? (el.tab.role === 'GROUP' ? 'groupe d’onglets' : 'onglet') : 'conteneur'} <${el.tag}> du gabarit de ${el.component}`,
            el.id,
          ),
          {
            component: el.component,
            tag: el.tag,
            ...(el.handler ? { handler: el.handler } : {}),
            ...(el.submit ? { submit: true } : {}),
            // L'événement n'est noté que s'il n'est pas un simple click (pas de faux changement face à un scan d'avant).
            ...(el.event && el.event !== 'click' && el.event !== 'ngSubmit' ? { event: el.event } : {}),
            ...(el.targetContext ? { context: el.targetContext } : {}),
            ...(el.unresolved ? { unresolved: el.unresolved } : {}),
            ...(el.tab
              ? {
                  tab: el.tab.role,
                  tabLibrary: el.tab.library,
                  ...(el.tab.label ? { tabLabel: el.tab.label } : {}),
                  ...(el.tab.lazy ? { lazy: el.tab.lazy } : {}),
                  ...(el.tab.repeat ? { repeat: el.tab.repeat } : {}),
                  ...(el.tab.items ? { items: el.tab.items } : {}),
                  ...(el.tab.route ? { route: el.tab.route } : {}),
                }
              : {}),
          },
          {
            parent: el.parent
              ? elementNode(el.parent, kinds.get(el.parent) ?? 'CONTAINER')
              : `COMPONENT:${src}:${el.component}`,
          },
        );
      for (const el of ui.elements ?? []) {
        const id = elementNode(el.id, el.kind);
        const owner = el.parent
          ? elementNode(el.parent, kinds.get(el.parent) ?? 'CONTAINER')
          : `COMPONENT:${src}:${el.component}`;
        edge(
          owner,
          id,
          'CONTAINS',
          'CONFIRMED',
          el.parent ? 'imbriqué dans le conteneur' : 'dans le gabarit du composant',
          [ev(src, el.loc, 'STATIC_CODE', 'CONFIRMED')],
        );
        for (const control of el.fields) {
          const field = ui.fields.find((f) => f.component === el.component && f.control === control);
          if (field)
            edge(
              id,
              `FIELD:${src}:${field.id}`,
              'CONTAINS',
              'CONFIRMED',
              `contrôle « ${control} » dans le conteneur`,
              [ev(src, field.loc, 'STATIC_CODE', 'CONFIRMED')],
            );
        }
        // Les conditions : la visibilité (bloc, *ngIf, [hidden], @else) et l'activation ([disabled]).
        for (const [aspect, cond] of [
          ['VISIBLE', el.visibleWhen],
          ['ENABLED', el.disabledWhen],
        ] as const) {
          if (!cond) continue;
          // Vraie quand l'expression est vraie, sauf [hidden], @else et [disabled] (vraie quand elle est fausse).
          const whenTrue = !(cond.how === 'hidden' || cond.how === 'else' || cond.how === 'disabled');
          const members = membersOf(cond.expression);
          const states = members.map((m) => ({
            m,
            state: ui.states?.find((st) => st.component === el.component && st.member === m.root),
          }));
          const condition = node(
            `CONDITION:${src}:${el.id}:${aspect.toLowerCase()}`,
            'CONDITION',
            'FRONTEND',
            cond.expression,
            ev(
              src,
              cond.loc,
              'STATIC_CODE',
              'CONFIRMED',
              `condition ${cond.how} : ${cond.expression}`,
              el.id,
            ),
            {
              aspect,
              how: cond.how,
              expression: cond.expression,
              whenTrue,
              element: id,
              sources: states.map(({ m, state }) => `${m.root}:${state?.kind ?? 'UNKNOWN'}`),
              // D'où vient chaque membre lu : producteur démontré (flux, réponse, écrivain), origine locale
              // terminale (valeur posée, accesseur, formulaire), candidat (entrée du parent) ou inconnu.
              producers: states.map(({ m, state }) => {
                const status = !state
                  ? 'UNKNOWN'
                  : state.kind === 'STREAM' || state.kind === 'RESPONSE' || state.writers?.length
                    ? 'DEMONSTRATED'
                    : state.kind === 'INPUT'
                      ? 'CANDIDATE'
                      : 'LOCAL_TERMINAL';
                return `${m.root}:${status}${status === 'UNKNOWN' ? ' (PRODUCER_UNRESOLVED)' : ''}`;
              }),
            },
            { parent: id },
          );
          edge(
            id,
            condition,
            aspect === 'VISIBLE' ? 'VISIBLE_WHEN' : 'ENABLED_WHEN',
            'CONFIRMED',
            `${cond.how} « ${cond.expression} »`,
            [ev(src, cond.loc, 'STATIC_CODE', 'CONFIRMED')],
          );
          for (const { m, state } of states) {
            // Les méthodes qui écrivent le membre (affectation, signal.set/update) : la condition en dépend.
            for (const w of state?.writers ?? [])
              edge(
                condition,
                `METHOD:${src}:${el.component}#${w.method}`,
                'DEPENDS_ON',
                'CONFIRMED',
                `${m.root} est écrit par ${w.method}() (${w.how === 'ASSIGN' ? 'affectation' : w.how === 'SET' ? 'set' : 'update'})`,
                [ev(src, w.loc, 'STATIC_CODE', 'CONFIRMED')],
              );
            if (state?.kind === 'STREAM' && state.stream) {
              edge(
                condition,
                `STREAM:${src}:${state.stream}`,
                'CONTROLLED_BY',
                'CONFIRMED',
                `${m.root}${m.path.length ? `.${m.path.join('.')}` : ''} lit le flux ${state.stream}`,
                [ev(src, state.loc, 'TEMPLATE', 'CONFIRMED')],
              );
              continue;
            }
            if (state?.kind !== 'RESPONSE' || !state.call) continue;
            const call = `METHOD:${src}:${state.call}`;
            edge(
              condition,
              call,
              'DEPENDS_ON',
              'CONFIRMED',
              `${m.root} est affecté par la réponse de ${state.call.replace('#', '.')}()`,
              [ev(src, state.loc, 'STATIC_CODE', 'CONFIRMED')],
            );
            // La propriété lue dans la réponse : celle de l'affectation, puis le chemin de l'expression.
            const property = [...(state.property ? state.property.split('.') : []), ...m.path][0];
            if (!property) continue;
            for (const served of edges.values()) {
              if (served.from !== call || served.kind !== 'CALLS') continue;
              const endpoint = nodes.get(served.to);
              const returns = endpoint?.detail.returns;
              if (typeof returns !== 'string') continue;
              const target = served.to.split(':')[1] ?? '';
              const field = jsonField(target, returns.replace(/^.*<\s*|\s*>.*$/g, ''), property);
              if (field)
                edge(
                  condition,
                  field,
                  'CONTROLLED_BY',
                  served.confidence,
                  `propriété « ${property} » de ${returns}, rendu par ${endpoint?.name ?? served.to}`,
                  [ev(src, state.loc, 'STATIC_CODE', served.confidence)],
                );
            }
          }
        }
        // Le bouton déclenche son gestionnaire (suivi à travers stores et flux), et les appels directs.
        // Un groupe d'onglets ou un lien d'onglet déclenche aussi son gestionnaire (changement d'onglet).
        if (
          el.kind === 'CONTAINER' &&
          el.tab &&
          el.handler &&
          nodes.has(`METHOD:${src}:${el.component}#${el.handler}`)
        )
          edge(
            id,
            `METHOD:${src}:${el.component}#${el.handler}`,
            'TRIGGERS',
            'CONFIRMED',
            `changement d’onglet → ${el.handler}()`,
            [ev(src, el.loc, 'STATIC_CODE', 'CONFIRMED')],
          );
        // L'onglet actif choisi par un flux (`[selectedIndex]="store.selected$ | async"`).
        if (el.tab?.selectedBy)
          for (const m of membersOf(el.tab.selectedBy.expression)) {
            const state = ui.states?.find((st) => st.component === el.component && st.member === m.root);
            if (state?.kind === 'STREAM' && state.stream)
              edge(
                id,
                `STREAM:${src}:${state.stream}`,
                'CONTROLLED_BY',
                'CONFIRMED',
                `l’onglet actif est choisi par ${el.tab.selectedBy.expression}`,
                [ev(src, el.tab.selectedBy.loc, 'TEMPLATE', 'CONFIRMED')],
              );
          }
        // Le déclencheur : la cible résolue de l'expression (méthode, ou méthode vue dans le contexte des
        // valeurs écrites dans le gabarit), sinon le gestionnaire nommé.
        const trigger = el.target
          ? `METHOD:${src}:${el.target}`
          : el.handler
            ? `METHOD:${src}:${el.component}#${el.handler}`
            : undefined;
        if (el.kind === 'BUTTON' && trigger && nodes.has(trigger))
          edge(
            id,
            trigger,
            'TRIGGERS',
            'CONFIRMED',
            `(${el.event ?? (el.submit ? 'ngSubmit' : 'click')})="${el.expression ?? `${el.handler ?? ''}()`}"${el.targetContext ? ` : contexte ${el.targetContext}` : ''}`,
            [ev(src, el.loc, 'TEMPLATE', 'CONFIRMED')],
            el.targetContext ? { context: el.targetContext, timing: 'ON_EVENT' } : { timing: 'ON_EVENT' },
          );
        if (el.kind === 'BUTTON' && el.handler) {
          const handler = ui.handlers?.find((h) => h.component === el.component && h.method === el.handler);
          for (const call of handler?.calls ?? [])
            edge(
              id,
              `METHOD:${src}:${call}`,
              'TRIGGERS',
              'CONFIRMED',
              `${el.submit ? '(ngSubmit)' : '(click)'}="${el.handler}()" → ${call.replace('#', '.')}()`,
              [
                ev(src, el.loc, 'STATIC_CODE', 'CONFIRMED'),
                ev(src, handler?.loc, 'STATIC_CODE', 'CONFIRMED'),
              ],
            );
        }
      }
    }
    // Les composants affichés par d'autres (dans un onglet, un conteneur, ou à la racine du gabarit), et les
    // onglets routés : l'arbre les imbrique (CONTAINS), la fonctionnalité de la page les atteint (DISPLAYS).
    if (ui) {
      const bySelector = new Map(
        ui.components.filter((c) => c.selector).map((c) => [c.selector ?? '', c.name] as const),
      );
      const names = new Set(ui.components.map((c) => c.name));
      for (const child of ui.children ?? []) {
        const name = child.tag
          ? bySelector.get(child.tag)
          : child.className && names.has(child.className)
            ? child.className
            : undefined;
        if (!name || name === child.component) continue;
        const target = `COMPONENT:${src}:${name}`;
        const holder = child.container
          ? `CONTAINER:${src}:${child.container}`
          : `COMPONENT:${src}:${child.component}`;
        const where = child.container ? nodes.get(holder)?.name : undefined;
        const later =
          child.lazy === 'TEMPLATE'
            ? ' — instancié à la sélection (gabarit différé)'
            : child.lazy === 'DEFER'
              ? ' — chargé plus tard (@defer)'
              : child.lazy === 'OUTLET'
                ? ' — créé par ngComponentOutlet'
                : '';
        const proof = [ev(src, child.loc, 'TEMPLATE', 'CONFIRMED', child.tag ?? child.className)];
        edge(
          holder,
          target,
          'CONTAINS',
          'CONFIRMED',
          `<${child.tag ?? child.className ?? name}> affiché${where ? ` dans « ${where} »` : ''}${later}`,
          proof,
        );
        edge(
          `COMPONENT:${src}:${child.component}`,
          target,
          'DISPLAYS',
          'CONFIRMED',
          `${child.component} affiche ${name}${later}`,
          proof,
        );
      }
      // Un onglet routé (`routerLink="history"`) : la route enfant de la page, puis son composant.
      for (const el of ui.elements ?? []) {
        const link = el.tab?.route;
        if (!link) continue;
        const id = `CONTAINER:${src}:${el.id}`;
        const routes = [...nodes.values()].filter(
          (n) => n.kind === 'ROUTE' && n.id.startsWith(`ROUTE:${src}:`),
        );
        const pathOf = (n: MapNode): string => `/${String(n.detail.path ?? '').replace(/^\/+|\/+$/g, '')}`;
        const pages = routes.filter((r) => edges.has(`DISPLAYS:${r.id}->COMPONENT:${src}:${el.component}`));
        const clean = link.replace(/^\.\//, '').replace(/\/+$/, '');
        const exact = routes.filter((r) =>
          clean.startsWith('/')
            ? pathOf(r) === clean
            : pages.some((p) => pathOf(r) === `${pathOf(p).replace(/\/$/, '')}/${clean}`),
        );
        const loose = exact.length
          ? exact
          : routes.filter((r) => pathOf(r).endsWith(`/${clean.replace(/^\//, '')}`));
        const detail = nodes.get(id)?.detail;
        if (loose.length !== 1) {
          if (detail)
            detail.routeUnresolved =
              loose.length === 0
                ? `aucune route ne correspond à routerLink="${link}"`
                : `routerLink="${link}" correspond à ${String(loose.length)} routes`;
          continue;
        }
        const route = loose[0] as MapNode;
        const shown = [...edges.values()].find((e) => e.kind === 'DISPLAYS' && e.from === route.id)?.to;
        if (!shown) continue;
        const confidence: MapConfidence = exact.length ? 'CONFIRMED' : 'PROBABLE';
        const proof = [ev(src, el.loc, 'TEMPLATE', confidence, `routerLink="${link}"`)];
        edge(
          id,
          shown,
          'CONTAINS',
          confidence,
          `onglet routé : routerLink="${link}" → route ${route.name}`,
          proof,
        );
        edge(
          `COMPONENT:${src}:${el.component}`,
          shown,
          'DISPLAYS',
          confidence,
          `${el.component} affiche la route ${route.name} (onglet routé, router-outlet)`,
          proof,
        );
      }
    }
    // Vue alimentation : une propriété lue par map()/filter() d'un flux alimenté par une réponse HTTP est
    // reliée à la propriété du type rendu par l'endpoint (réponse → store → flux → condition). Probable :
    // la correspondance passe par le nom de la propriété lue.
    if (ui?.symbols?.some((sym) => sym.stream?.reads?.length)) {
      const outOf = new Map<string, MapEdge[]>();
      for (const e of edges.values()) outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
      for (const sym of ui.symbols) {
        const reads = sym.stream?.reads ?? [];
        if (reads.length === 0) continue;
        const sid = `STREAM:${src}:${sym.id}`;
        const seen = new Set([sid]);
        let frontier = [sid];
        const feeders: string[] = [];
        for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
          const next: string[] = [];
          for (const id of frontier)
            for (const e of outOf.get(id) ?? []) {
              if (e.kind !== 'DEPENDS_ON' || seen.has(e.to)) continue;
              seen.add(e.to);
              if (nodes.get(e.to)?.detail.httpMethod !== undefined) feeders.push(e.to);
              else next.push(e.to);
            }
          frontier = next;
        }
        for (const feeder of feeders)
          for (const served of outOf.get(feeder) ?? []) {
            const returns = nodes.get(served.to)?.detail.returns;
            if (served.kind !== 'CALLS' || typeof returns !== 'string') continue;
            const target = served.to.split(':')[1] ?? '';
            for (const property of reads) {
              const field = jsonField(target, returns.replace(/^.*<\s*|\s*>.*$/g, ''), property);
              if (field)
                edge(
                  sid,
                  field,
                  'CONTROLLED_BY',
                  'PROBABLE',
                  `propriété « ${property} » lue par ${sym.id} dans la réponse ${returns} de ${nodes.get(served.to)?.name ?? served.to}`,
                  [ev(src, sym.loc, 'STATIC_CODE', 'PROBABLE')],
                );
            }
          }
      }
    }
    const java = facts.java;
    if (java) {
      const methodId = (owner: string, name: string): string | undefined => {
        const found = java.methods.find((m) => m.owner === owner && m.name === name);
        return found ? `METHOD:${found.id}` : undefined;
      };
      // Un champ calculé par une méthode : piloté par elle.
      for (const entry of java.computed ?? []) {
        const field = fieldNode(src, entry.toClass, entry.toField);
        const [owner = '', name = ''] = entry.callee.split('.');
        const method = methodId(owner, name);
        if (field && method)
          edge(
            field,
            method,
            'CONTROLLED_BY',
            'CONFIRMED',
            `valeur calculée par ${entry.callee}() dans ${entry.method}()`,
            [ev(src, entry.loc, 'STATIC_CODE', 'CONFIRMED')],
          );
      }
      // Une méthode de décision : ses boucles, prédicats et lectures ; l'entité qu'elle lit en paramètre.
      for (const decision of java.decisions ?? []) {
        const method = methodId(decision.owner, decision.name);
        const target = method ? nodes.get(method) : undefined;
        if (!method || !target) continue;
        target.detail.decision = true;
        target.detail.loops = decision.loops;
        target.detail.predicates = decision.predicates;
        target.detail.reads = decision.reads;
        for (const param of new Set(decision.params)) {
          const read = decision.reads.filter((r) => r.startsWith(`${param}.`));
          if (read.length && nodes.has(`ENTITY:${src}:${param}`))
            edge(
              method,
              `ENTITY:${src}:${param}`,
              'READS',
              'CONFIRMED',
              `lit ${read.join(', ')} (paramètre ${param})`,
              [ev(src, decision.loc, 'STATIC_CODE', 'CONFIRMED')],
            );
        }
      }
    }
  }

  // Endpoint servi ↔ opération du contrat : même méthode, même chemin. Plusieurs contrats peuvent décrire
  // la même route (le contrat du serveur et la copie qu'un client garde) : celui de la même source d'abord,
  // puis un contrat lu par une génération serveur, puis les autres ; une copie seulement cliente en dernier.
  const contractInfo = new Map(contractIndex.contracts().map((c) => [c.id, c]));
  const docOfOp = new Map<string, string>();
  for (const f of input.facts)
    for (const op of f.openapi?.operations ?? [])
      docOfOp.set(opNodeOf(f.sourceId, op.id), `${f.sourceId}:${op.document ?? op.loc.file}`);
  for (const entry of served) {
    // Un endpoint déduit est déjà relié à l'opération d'où vient sa route.
    if (entry.kind === 'INFERRED') continue;
    const rank = (c: Served): number => {
      if (c.sourceId === entry.sourceId) return 0;
      const info = contractInfo.get(docOfOp.get(c.endpoint.symbolId) ?? '');
      if (info?.consumers.some((k) => k.side === 'SERVER')) return 1;
      if (info && info.consumers.length > 0 && info.consumers.every((k) => k.side === 'CLIENT')) return 3;
      return 2;
    };
    const op = contracts
      .filter((c) => matchEndpoint({ endpoints: [c.endpoint] }, entry.endpoint.method, entry.endpoint.path))
      .sort((a, b) => rank(a) - rank(b))[0];
    if (!op) continue;
    edge(
      entry.endpoint.symbolId,
      op.endpoint.symbolId,
      'DEPENDS_ON',
      'CONFIRMED',
      'décrit par le contrat d’API (même méthode, même chemin)',
      [ev(op.sourceId, undefined, 'OPENAPI', 'CONFIRMED')],
    );
    if (entry.requestBody && op.requestBody) {
      const java = javaClasses.get(entry.requestBody)?.find((c) => c.sourceId === entry.sourceId)?.cls;
      for (const field of java?.fields ?? []) {
        const to = `FIELD:${op.sourceId}:${op.requestBody}.${field.jsonName ?? field.name}`;
        const from = fieldNode(entry.sourceId, entry.requestBody, field.name);
        if (from && nodes.has(to))
          edge(from, to, 'DEPENDS_ON', 'CONFIRMED', `défini par le schéma ${op.requestBody} du contrat`, [
            ev(op.sourceId, undefined, 'OPENAPI', 'CONFIRMED'),
          ]);
      }
    }
  }

  // ── Onglets : dépendances par stores partagés, composants réutilisés, préconditions d'accès ───────
  {
    const outOf = new Map<string, MapEdge[]>();
    const inOf = new Map<string, MapEdge[]>();
    for (const e of edges.values()) {
      outOf.set(e.from, [...(outOf.get(e.from) ?? []), e]);
      inOf.set(e.to, [...(inOf.get(e.to) ?? []), e]);
    }
    const isTab = (n: MapNode | undefined): boolean => n?.kind === 'CONTAINER' && n.detail.tab === 'TAB';
    const tabName = (n: MapNode): string =>
      typeof n.detail.tabLabel === 'string'
        ? n.detail.tabLabel
        : typeof n.detail.repeat === 'string'
          ? `${n.name} (généré par ${n.detail.repeat})`
          : n.name;
    /** Le contenu d'un onglet : éléments et composants imbriqués (borné, sans cycle). */
    const contentOf = (id: string): Set<string> => {
      const seen = new Set<string>([id]);
      const queue = [id];
      while (queue.length > 0 && seen.size < 2000) {
        const cur = queue.shift() ?? '';
        for (const e of outOf.get(cur) ?? [])
          if (e.kind === 'CONTAINS' && !seen.has(e.to)) {
            seen.add(e.to);
            queue.push(e.to);
          }
      }
      return seen;
    };
    /** Les flux qu'un contenu modifie (déclenchement : bouton, gestionnaire, cycle de vie), et par où. */
    const writesOf = (content: ReadonlySet<string>): Map<string, string> => {
      const starts: string[] = [];
      for (const id of content)
        for (const e of outOf.get(id) ?? [])
          if (e.kind === 'TRIGGERS' || (e.kind === 'CALLS' && nodes.get(id)?.kind === 'COMPONENT'))
            starts.push(e.to);
      const via = new Map<string, string>();
      const seen = new Set(starts);
      const queue = starts.map((s) => [s, s] as const);
      while (queue.length > 0 && seen.size < 5000) {
        const [cur, from] = queue.shift() ?? ['', ''];
        for (const e of outOf.get(cur) ?? []) {
          if (e.kind !== 'CALLS' || e.confidence === 'UNKNOWN' || seen.has(e.to)) continue;
          seen.add(e.to);
          if (nodes.get(e.to)?.kind === 'STREAM' && !via.has(e.to))
            via.set(e.to, cur.includes('#') ? cur : from);
          queue.push([e.to, nodes.get(cur)?.kind === 'METHOD' ? cur : from]);
        }
      }
      return via;
    };
    /** Les flux lus par les conditions de l'onglet et de son contenu (avec leurs sources), et lesquels
     * pilotent l'activation de l'onglet lui-même. */
    const readsOf = (
      tab: string,
      content: ReadonlySet<string>,
    ): { all: Set<string>; enabling: Set<string> } => {
      const all = new Set<string>();
      const enabling = new Set<string>();
      for (const id of content)
        for (const c of outOf.get(id) ?? []) {
          if (c.kind !== 'VISIBLE_WHEN' && c.kind !== 'ENABLED_WHEN') continue;
          const queue = (outOf.get(c.to) ?? []).filter((e) => e.kind === 'CONTROLLED_BY').map((e) => e.to);
          const seen = new Set<string>();
          while (queue.length > 0 && seen.size < 500) {
            const cur = queue.shift() ?? '';
            if (seen.has(cur) || nodes.get(cur)?.kind !== 'STREAM') continue;
            seen.add(cur);
            all.add(cur);
            if (id === tab && c.kind === 'ENABLED_WHEN') enabling.add(cur);
            for (const e of outOf.get(cur) ?? []) if (e.kind === 'DEPENDS_ON') queue.push(e.to);
          }
        }
      return { all, enabling };
    };
    const tabs = [...nodes.values()].filter(isTab);
    const contents = new Map(tabs.map((t) => [t.id, contentOf(t.id)]));
    const writes = new Map(tabs.map((t) => [t.id, writesOf(contents.get(t.id) ?? new Set())]));
    for (const reader of tabs) {
      const reads = readsOf(reader.id, contents.get(reader.id) ?? new Set());
      for (const writer of tabs) {
        if (writer === reader) continue;
        // Un onglet et un onglet qu'il contient ne sont pas deux onglets voisins.
        if (contents.get(writer.id)?.has(reader.id) || contents.get(reader.id)?.has(writer.id)) continue;
        for (const [stream, by] of writes.get(writer.id) ?? []) {
          if (!reads.all.has(stream)) continue;
          const fromResponse = (outOf.get(stream) ?? []).some(
            (e) => e.kind === 'DEPENDS_ON' && nodes.get(e.to)?.detail.httpMethod !== undefined,
          );
          const effect = reads.enabling.has(stream) ? 'son activation dépend de' : 'il lit';
          edge(
            reader.id,
            writer.id,
            'DEPENDS_ON',
            'PROBABLE',
            `« ${tabName(reader)} » : ${effect} ${nodes.get(stream)?.name ?? stream}, que « ${tabName(writer)} » modifie par ${by.replace(/^METHOD:[^:]+:/, '').replace('#', '.')}()${fromResponse ? ' (valeur venant d’une réponse du serveur)' : ''} — l’ordre réel des actions n’est pas démontré`,
            [
              ...(reader.evidence[0] ? [reader.evidence[0]] : []),
              ...(writer.evidence[0] ? [writer.evidence[0]] : []),
            ],
          );
          break;
        }
      }
    }
    // Composants réutilisés : affichés à plusieurs endroits (onglets, conteneurs).
    for (const n of nodes.values()) {
      if (n.kind !== 'COMPONENT') continue;
      const holders = (inOf.get(n.id) ?? [])
        .filter((e) => e.kind === 'CONTAINS')
        .map((e) => nodes.get(e.from));
      const where = [
        ...new Set(
          holders
            .filter((h): h is MapNode => h !== undefined)
            .map((h) => (isTab(h) ? `onglet « ${tabName(h)} »` : h.name)),
        ),
      ];
      if (where.length > 1) n.detail.reusedIn = where;
    }
    // Préconditions d'un onglet : ce que le code montre pour l'atteindre (écran, onglets parents, conditions).
    const pageOf = (component: string, depth = 0): string | undefined => {
      if (depth > 8) return undefined;
      const route = (inOf.get(component) ?? []).find(
        (e) => e.kind === 'DISPLAYS' && nodes.get(e.from)?.kind === 'ROUTE',
      );
      if (route) return nodes.get(route.from)?.name;
      const parent = (inOf.get(component) ?? []).find(
        (e) => e.kind === 'DISPLAYS' && nodes.get(e.from)?.kind === 'COMPONENT',
      );
      return parent ? pageOf(parent.from, depth + 1) : undefined;
    };
    const conditionsOf = (id: string, kind: 'VISIBLE_WHEN' | 'ENABLED_WHEN'): string[] =>
      (outOf.get(id) ?? [])
        .filter((e) => e.kind === kind)
        .map((e) => nodes.get(e.to)?.detail.expression)
        .filter((x): x is string => typeof x === 'string');
    for (const tab of tabs) {
      const chain: MapNode[] = [];
      let cursor: string | undefined = tab.id;
      let page: string | undefined;
      for (let guard = 0; cursor && guard < 30; guard += 1) {
        const n = nodes.get(cursor);
        if (!n) break;
        if (n.kind === 'COMPONENT' && page === undefined) page = pageOf(n.id);
        chain.unshift(n);
        cursor = (inOf.get(cursor) ?? []).find((e) => e.kind === 'CONTAINS')?.from;
      }
      const steps: string[] = [
        page
          ? `ouvrir l’écran ${page}`
          : `accès non démontré : ${String(tab.detail.component)} n’est affiché par aucune route lue`,
      ];
      for (const n of chain) {
        for (const expr of conditionsOf(n.id, 'VISIBLE_WHEN'))
          steps.push(`condition d’affichage vraie : ${expr}`);
        if (!isTab(n)) continue;
        const name = tabName(n);
        steps.push(
          typeof n.detail.repeat === 'string'
            ? `sélectionner un onglet généré par ${n.detail.repeat}${Array.isArray(n.detail.items) ? ` (${n.detail.items.join(', ')})` : ''}`
            : `sélectionner l’onglet « ${name} »`,
        );
        for (const expr of conditionsOf(n.id, 'ENABLED_WHEN'))
          steps.push(`onglet « ${name} » activé : ${expr} doit être faux`);
        for (const dep of (outOf.get(n.id) ?? []).filter(
          (e) => e.kind === 'DEPENDS_ON' && isTab(nodes.get(e.to)),
        ))
          steps.push(
            `préalable possible dans « ${tabName(nodes.get(dep.to) as MapNode)} » : ${dep.reason.split(' — ')[0] ?? dep.reason}`,
          );
      }
      if (typeof tab.detail.lazy === 'string')
        steps.push(
          tab.detail.lazy === 'ROUTE'
            ? 'le contenu est la route de l’onglet (router-outlet)'
            : 'le contenu n’est instancié qu’à la sélection de l’onglet',
        );
      tab.detail.preconditions = steps;
    }
  }

  // Le raccourci « bouton → méthode appelée par son gestionnaire » ne vaut pas mieux que l'appel lui-même :
  // un appel dont l'Observable n'est jamais souscrit crée la requête sans l'exécuter (non démontré).
  const triggered = new Map<string, MapEdge[]>();
  for (const e of edges.values())
    if (e.kind === 'TRIGGERS' && nodes.get(e.from)?.kind === 'BUTTON')
      triggered.set(e.from, [...(triggered.get(e.from) ?? []), e]);
  for (const list of triggered.values())
    for (const e of list) {
      const via = list.find((t) => t.to !== e.to && edges.has(`CALLS:${t.to}->${e.to}`));
      const call = via ? edges.get(`CALLS:${via.to}->${e.to}`) : undefined;
      if (!call || RANK[call.confidence] >= RANK[e.confidence]) continue;
      e.confidence = call.confidence;
      e.reason = `${e.reason} — ${call.reason}`;
    }

  // ── Fonctionnalités ───────────────────────────────────────────────────────────────────────────
  const out = new Map<string, MapEdge[]>();
  for (const e of edges.values()) out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const FLOW: ReadonlySet<MapEdgeKind> = new Set([
    'CALLS',
    'DEPENDS_ON',
    'READS',
    'WRITES',
    'DISPLAYS',
    'INPUTS',
  ]);
  const reach = (starts: Map<string, MapConfidence>): Map<string, MapConfidence> => {
    const seen = new Map(starts);
    const queue = [...starts.keys()];
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      for (const e of out.get(current) ?? []) {
        if (!FLOW.has(e.kind)) continue;
        // Une méthode d'un service ne mène pas à toutes les méthodes de ce service.
        if (nodes.get(current)?.kind === 'SERVICE') continue;
        // Un flux atteint par déclenchement ne mène pas à ses sources de données (seulement à ses traitements).
        if (nodes.get(current)?.kind === 'STREAM' && e.kind !== 'CALLS') continue;
        const confidence = weakest(seen.get(current) ?? 'UNKNOWN', e.confidence);
        const known = seen.get(e.to);
        if (known !== undefined && RANK[known] >= RANK[confidence]) continue;
        seen.set(e.to, confidence);
        queue.push(e.to);
      }
    }
    return seen;
  };
  /** Les champs atteints, et ceux des DTO, entités et composants atteints (leurs conteneurs). */
  const fieldsOf = (set: Map<string, MapConfidence>): string[] => {
    const out: string[] = [];
    for (const n of nodes.values()) {
      if (n.kind !== 'FIELD' && n.kind !== 'COLUMN') continue;
      if (set.has(n.id) || (n.parent && set.has(n.parent) && n.parent.split(':')[0] !== 'COMPONENT')) {
        out.push(n.id);
        if (!set.has(n.id) && n.parent) set.set(n.id, set.get(n.parent) ?? 'UNKNOWN');
      }
    }
    return out;
  };

  const features: Feature[] = [];
  const claimed = new Set<string>();
  /** Les ruptures relevées dans les composants atteints. */
  const diagnosticsIn = (set: Map<string, MapConfidence>): { diagnostics?: string[] } => {
    const list = [...set.keys()].flatMap((id) => {
      const n = nodes.get(id);
      return n?.kind === 'COMPONENT' && Array.isArray(n.detail.diagnostics) ? n.detail.diagnostics : [];
    });
    return list.length ? { diagnostics: [...new Set(list)].slice(0, 12) } : {};
  };
  const chainOf = (set: Map<string, MapConfidence>, title: string, start: MapLayer): ChainStep[] => {
    const steps: ChainStep[] = [];
    const pick = (layer: MapLayer, kinds: MapNodeKind[]): MapNode[] =>
      [...set.keys()]
        .map((id) => nodes.get(id))
        .filter((n): n is MapNode => n !== undefined && n.layer === layer && kinds.includes(n.kind));
    const add = (n: MapNode, label: string): void => {
      steps.push({ layer: n.layer, node: n.id, label, confidence: set.get(n.id) ?? 'UNKNOWN' });
    };
    if (start === 'FRONTEND') {
      for (const route of pick('FRONTEND', ['ROUTE'])) add(route, `Écran « ${title} » (${route.name})`);
      const fields = pick('FRONTEND', ['FIELD']).filter((n) => n.parent?.startsWith('COMPONENT:'));
      // Le composant de l'écran est son formulaire ; les composants qu'il affiche (onglets…) sont nommés.
      const displayed = new Set(
        pick('FRONTEND', ['ROUTE']).flatMap((r) =>
          (out.get(r.id) ?? []).filter((e) => e.kind === 'DISPLAYS').map((e) => e.to),
        ),
      );
      for (const component of pick('FRONTEND', ['COMPONENT'])) {
        const count = fields.filter((f) => f.parent === component.id).length;
        add(
          component,
          displayed.has(component.id) || displayed.size === 0
            ? `Formulaire (${String(count)} champ${count > 1 ? 's' : ''})`
            : `Composant ${component.name}${count ? ` (${String(count)} champ${count > 1 ? 's' : ''})` : ''}`,
        );
      }
      // Les étapes du frontal dans l'ordre du parcours : action du composant, store, flux, service, appel HTTP.
      // D'abord celles qui mènent à un appel HTTP ; une étape atteinte seulement par un lien non démontré
      // (flux jamais souscrit, Observable perdu) n'est pas une étape du parcours.
      const reachable = pick('FRONTEND', ['METHOD', 'STREAM']).filter((n) => set.get(n.id) !== 'UNKNOWN');
      const leading = new Set(reachable.filter((n) => n.detail.httpMethod !== undefined).map((n) => n.id));
      const demonstrated = (e: MapEdge): boolean => e.kind === 'CALLS' && e.confidence !== 'UNKNOWN';
      for (let changed = true; changed;) {
        changed = false;
        for (const n of reachable)
          if (!leading.has(n.id) && (out.get(n.id) ?? []).some((e) => demonstrated(e) && leading.has(e.to))) {
            leading.add(n.id);
            changed = true;
          }
      }
      // Parcours par parcours (profondeur d'abord depuis l'écran), puis les étapes sans appel HTTP.
      const ordered: MapNode[] = [];
      const placed = new Set<string>();
      const walk = (id: string): void => {
        for (const e of out.get(id) ?? []) {
          if (!demonstrated(e) || placed.has(e.to) || !leading.has(e.to)) continue;
          const n = nodes.get(e.to);
          if (!n) continue;
          placed.add(e.to);
          ordered.push(n);
          walk(e.to);
        }
      };
      for (const c of pick('FRONTEND', ['COMPONENT'])) walk(c.id);
      const fronts = [
        ...ordered,
        ...reachable.filter((n) => leading.has(n.id) && !placed.has(n.id)),
        ...reachable.filter((n) => !leading.has(n.id)),
      ];
      const shown = fronts.slice(0, MAX_FRONT_STEPS);
      for (const n of shown) add(n, frontLabel(n));
      if (fronts.length > shown.length)
        steps.push({
          layer: 'FRONTEND',
          node: '',
          label: `+${String(fronts.length - shown.length)} étape(s)`,
          confidence: 'PROBABLE',
        });
      // Aucun appel HTTP atteint : l'étape exacte où la chaîne s'arrête, quand l'analyse la connaît.
      if (!fronts.some((n) => n.detail.httpMethod !== undefined)) {
        const why = pick('FRONTEND', ['COMPONENT']).flatMap((c) =>
          Array.isArray(c.detail.diagnostics) ? c.detail.diagnostics : [],
        );
        if (why.length > 0)
          steps.push({
            layer: 'FRONTEND',
            node: '',
            label: '—',
            confidence: 'UNKNOWN',
            gap: `lien non démontré : ${[...new Set(why)].slice(0, 3).join(' ; ')}`,
          });
      }
    }
    // Pourquoi le frontal ne rejoint pas la couche suivante : aucun appel, URL non résolue, ambiguïté, sans
    // correspondance.
    const frontWhy = ((): string | undefined => {
      if (start !== 'FRONTEND') return undefined;
      const httpCalls = pick('FRONTEND', ['METHOD']).filter((n) => n.detail.httpMethod !== undefined);
      if (httpCalls.length === 0) return 'lien non démontré : aucun appel HTTP n’est atteint depuis l’écran';
      const reasons = httpCalls.map((n) =>
        typeof n.detail.unresolved === 'string'
          ? `${n.name}() : ${n.detail.unresolved}${typeof n.detail.urlExpression === 'string' ? ` (${n.detail.urlExpression})` : ''}`
          : typeof n.detail.match === 'string'
            ? `${String(n.detail.httpMethod)} ${String(n.detail.path)} : ${n.detail.match}`
            : undefined,
      );
      const known = reasons.filter((r): r is string => r !== undefined);
      return known.length > 0
        ? `lien non démontré : ${[...new Set(known)].slice(0, 3).join(' ; ')}`
        : undefined;
    })();
    let explained = false;
    const layers: MapLayer[] = ['BFF', 'BACKEND', 'API', 'DATABASE'];
    const order: MapLayer[] = ['FRONTEND', ...layers];
    if (start !== 'FRONTEND' && layersPresent.has('FRONTEND'))
      steps.push({
        layer: 'FRONTEND',
        node: '',
        label: '—',
        confidence: 'UNKNOWN',
        gap: 'lien non démontré : aucun écran analysé n’appelle cet endpoint',
      });
    for (const layer of layers) {
      if (layer === 'DATABASE') {
        for (const entity of pick('DATABASE', ['ENTITY'])) add(entity, `Table ${entity.name}`);
      } else {
        const apis = pick(layer, ['API']);
        for (const api of apis)
          add(api, `${api.name}${api.detail.handler ? ` (${String(api.detail.handler)})` : ''}`);
        if (layer !== 'API')
          for (const method of pick(layer, ['METHOD'])
            .filter((m) => m.detail.role === 'SERVICE')
            .slice(0, 3))
            add(method, `${method.name}()`);
      }
      const expected =
        layer === 'DATABASE'
          ? [...layersPresent].some((l) => l === 'BACKEND' || l === 'DATABASE') &&
            [...nodes.values()].some((n) => n.kind === 'ENTITY')
          : layersPresent.has(layer) ||
            (layer === 'API' && [...nodes.values()].some((n) => n.layer === 'API'));
      if (
        expected &&
        !steps.some((step) => step.layer === layer) &&
        (start === 'FRONTEND' || layer !== start)
      ) {
        // La raison précise côté frontal ne s'écrit qu'une fois, à la première couche manquante.
        const fromFront = frontWhy !== undefined && !explained && layer !== 'DATABASE' && layer !== 'API';
        if (fromFront) explained = true;
        steps.push({
          layer,
          node: '',
          label: '—',
          confidence: 'UNKNOWN',
          gap:
            fromFront && frontWhy
              ? frontWhy
              : layer === 'DATABASE'
                ? 'lien non démontré : aucune écriture ni lecture d’une entité n’a été retrouvée dans la chaîne'
                : order.indexOf(layer) < order.indexOf(start)
                  ? `lien non démontré : aucun appel de la couche ${layer} vers cet endpoint n’a été retrouvé`
                  : `lien non démontré : aucun endpoint ${layer === 'API' ? 'du contrat' : `de la couche ${layer}`} ne correspond aux appels de la chaîne`,
        });
      }
    }
    return steps;
  };

  for (const facts of input.facts) {
    const src = facts.sourceId;
    for (const route of facts.ui?.routes ?? []) {
      if (!route.component) continue;
      const routeId = `ROUTE:${src}:${route.path}`;
      const starts = new Map<string, MapConfidence>([[routeId, 'CONFIRMED']]);
      const set = reach(starts);
      for (const id of set.keys()) claimed.add(id);
      const title = humanize(route.component);
      const evidenceOf = nodes.get(routeId)?.evidence ?? [];
      features.push({
        id: `FEATURE:${routeId}`,
        name: title,
        proposedName: title,
        ...(route.path.split('/').filter(Boolean)[0]
          ? { module: route.path.split('/').filter(Boolean)[0] }
          : {}),
        status: 'CANDIDATE',
        layers: [
          ...new Set(
            [...set.keys()].map((id) => nodes.get(id)?.layer).filter((l): l is MapLayer => l !== undefined),
          ),
        ],
        nodes: [...set.keys()],
        fields: fieldsOf(set),
        chain: chainOf(set, title, 'FRONTEND'),
        ...diagnosticsIn(set),
        basis: `l’écran ${route.path} (${route.component}) et les appels de son formulaire`,
        evidence: evidenceOf,
        reach: Object.fromEntries(set),
      });
    }
  }
  // Les endpoints qu'aucun écran n'atteint : une fonctionnalité d'API (backend, BFF ou contrat).
  for (const entry of [...served, ...contracts]) {
    const id = entry.endpoint.symbolId;
    if (claimed.has(id)) continue;
    // Une opération du contrat déjà décrite par un endpoint servi est regroupée avec lui.
    if (entry.layer === 'API' && [...edges.values()].some((e) => e.to === id && e.kind === 'DEPENDS_ON'))
      continue;
    const set = reach(new Map([[id, 'CONFIRMED']]));
    for (const reached of set.keys()) claimed.add(reached);
    const api = nodes.get(id);
    const contract = [...set.keys()].map((key) => nodes.get(key)).find((n) => n?.layer === 'API');
    const title = humanize(
      String(
        contract?.detail.summary ??
          contract?.detail.operationId ??
          api?.detail.operationId ??
          api?.detail.summary ??
          handlerTitle(String(api?.detail.handler ?? api?.name ?? id)),
      ),
    );
    const tag = Array.isArray(contract?.detail.tags) ? contract.detail.tags[0] : undefined;
    features.push({
      id: `FEATURE:${id}`,
      name: title,
      proposedName: title,
      ...(tag
        ? { module: tag }
        : api?.detail.handler
          ? { module: humanize(String(api.detail.handler).split('.')[0] ?? '') }
          : {}),
      status: 'CANDIDATE',
      layers: [
        ...new Set(
          [...set.keys()].map((key) => nodes.get(key)?.layer).filter((l): l is MapLayer => l !== undefined),
        ),
      ],
      nodes: [...set.keys()],
      fields: fieldsOf(set),
      chain: chainOf(set, title, entry.layer),
      basis: `l’endpoint ${entry.endpoint.method} ${entry.endpoint.path}, qu’aucun écran analysé n’appelle`,
      evidence: api?.evidence ?? [],
      reach: Object.fromEntries(set),
    });
  }

  // ── Champs : la chaîne de chaque champ, puis les concepts (composantes reliées) ─────────────────
  const FIELD_EDGES: ReadonlySet<MapEdgeKind> = new Set(['SENDS', 'TRANSFORMS', 'DEPENDS_ON', 'READS']);
  const isField = (id: string): boolean => {
    const kind = nodes.get(id)?.kind;
    return kind === 'FIELD' || kind === 'COLUMN';
  };
  // Dans une même chaîne : un champ du corps reçu et une colonne de même nom de l'entité écrite, sans mapping explicite → probable.
  for (const feature of features) {
    const dtoFields = feature.fields.filter(
      (id) => nodes.get(id)?.kind === 'FIELD' && nodes.get(id)?.layer === 'BACKEND',
    );
    const columns = feature.fields.filter((id) => nodes.get(id)?.kind === 'COLUMN');
    for (const from of dtoFields) {
      const already = [...edges.values()].some(
        (e) => e.from === from && e.kind === 'TRANSFORMS' && nodes.get(e.to)?.kind === 'COLUMN',
      );
      if (already) continue;
      const key = String(nodes.get(from)?.detail.javaField ?? nodes.get(from)?.name ?? '');
      for (const column of columns)
        if (String(nodes.get(column)?.detail.field ?? '') === key)
          edge(
            from,
            column,
            'TRANSFORMS',
            'PROBABLE',
            `même nom (${key}) dans la même chaîne, mais aucun mapping explicite n’a été lu`,
            [...(nodes.get(from)?.evidence.slice(0, 1) ?? [])],
          );
    }
  }
  const neighbours = new Map<string, Set<string>>();
  for (const e of edges.values()) {
    if (!FIELD_EDGES.has(e.kind) || !isField(e.from) || !isField(e.to)) continue;
    neighbours.set(e.from, (neighbours.get(e.from) ?? new Set()).add(e.to));
    neighbours.set(e.to, (neighbours.get(e.to) ?? new Set()).add(e.from));
  }
  const concepts: FieldConcept[] = [];
  const conceptOf = new Map<string, string>();
  const frontFields = [...nodes.values()].filter((n) => isField(n.id));
  // Le point de départ : les champs saisis d'abord (le concept porte leur libellé).
  const rankOf = (n: MapNode): number =>
    n.parent?.startsWith('COMPONENT:') ? 0 : n.layer === 'FRONTEND' ? 1 : 2;
  frontFields.sort((a, b) => rankOf(a) - rankOf(b) || a.id.localeCompare(b.id));
  for (const start of frontFields) {
    if (conceptOf.has(start.id)) continue;
    const members: string[] = [];
    const queue = [start.id];
    conceptOf.set(start.id, `CONCEPT:${start.id}`);
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      members.push(current);
      for (const next of neighbours.get(current) ?? []) {
        if (conceptOf.has(next)) continue;
        conceptOf.set(next, `CONCEPT:${start.id}`);
        queue.push(next);
      }
    }
    const inner = [...edges.values()].filter(
      (e) => FIELD_EDGES.has(e.kind) && members.includes(e.from) && members.includes(e.to),
    );
    const confidence: MapConfidence =
      inner.length === 0 ? 'CONFIRMED' : weakest(...inner.map((e) => e.confidence));
    const label = members.map((id) => nodes.get(id)?.label).find((value) => value !== undefined);
    concepts.push({
      id: `CONCEPT:${start.id}`,
      name: label ?? humanize(String(start.detail.javaField ?? start.detail.field ?? start.name)),
      fields: members,
      features: features
        .filter((feature) => feature.fields.some((id) => members.includes(id)))
        .map((feature) => feature.id),
      layers: [
        ...new Set(members.map((id) => nodes.get(id)?.layer).filter((l): l is MapLayer => l !== undefined)),
      ],
      status: confidence,
      gaps: [],
      homonyms: [],
    });
  }
  // Les étapes non démontrées de chaque concept, et les homonymes (même nom, sans lien).
  const keyOf = (id: string): string =>
    String(
      nodes.get(id)?.detail.javaField ?? nodes.get(id)?.detail.field ?? nodes.get(id)?.name ?? '',
    ).toLowerCase();
  for (const concept of concepts) {
    const has = (layer: MapLayer): boolean => concept.fields.some((id) => nodes.get(id)?.layer === layer);
    const front = concept.fields.filter(
      (id) => nodes.get(id)?.layer === 'FRONTEND' && nodes.get(id)?.parent?.startsWith('COMPONENT:'),
    );
    for (const id of front) {
      const sends = [...edges.values()].filter((e) => e.from === id && e.kind === 'SENDS');
      if (sends.length === 0)
        concept.gaps.push(`lien non démontré : ${nodes.get(id)?.name ?? id} n’est envoyé par aucun appel lu`);
      else if (!sends.some((e) => isField(e.to)) && sends.some((e) => !isField(e.to))) {
        const call = sends.find((e) => !isField(e.to))?.to ?? '';
        const reached = [...edges.values()].some((e) => e.from === call && e.kind === 'CALLS');
        concept.gaps.push(
          reached
            ? `lien non démontré : la propriété envoyée par ${nodes.get(id)?.name ?? id} n’existe pas dans le corps reçu`
            : `lien non démontré : l’appel ${nodes.get(call)?.name ?? call} ne correspond à aucun endpoint analysé`,
        );
      }
    }
    if (
      (has('BACKEND') || has('BFF')) &&
      !has('DATABASE') &&
      [...nodes.values()].some((n) => n.kind === 'COLUMN')
    )
      concept.gaps.push('lien non démontré : aucune colonne persistée n’est reliée (mapping non lu)');
    const keys = new Set(concept.fields.map(keyOf));
    concept.homonyms = concepts
      .filter((other) => other.id !== concept.id && other.fields.some((id) => keys.has(keyOf(id))))
      .map((other) => other.id);
  }

  // ── Anomalies des champs ──────────────────────────────────────────────────────────────────────
  const issues: FieldIssue[] = [];
  for (const n of nodes.values()) {
    if (n.kind !== 'FIELD' || n.layer !== 'FRONTEND' || !n.parent?.startsWith('COMPONENT:')) continue;
    const sent = [...edges.values()].some(
      (e) => e.from === n.id && (e.kind === 'SENDS' || e.kind === 'TRANSFORMS'),
    );
    if (n.detail.bound === false && !sent)
      issues.push({
        kind: 'UNUSED',
        fields: [n.id],
        message: `${n.label ?? n.name} : déclaré, relié à aucun élément du gabarit et envoyé par aucun appel`,
      });
  }
  const byComponent = new Map<string, MapNode[]>();
  for (const n of nodes.values())
    if (n.kind === 'FIELD' && n.layer === 'FRONTEND' && n.label && n.parent?.startsWith('COMPONENT:'))
      byComponent.set(n.parent, [...(byComponent.get(n.parent) ?? []), n]);
  for (const list of byComponent.values()) {
    const seen = new Map<string, MapNode>();
    for (const n of list) {
      const key = (n.label ?? '').toLowerCase();
      const other = seen.get(key);
      if (other)
        issues.push({
          kind: 'DUPLICATE',
          fields: [other.id, n.id],
          message: `deux champs du même formulaire portent le libellé « ${n.label ?? ''} »`,
        });
      else seen.set(key, n);
    }
  }
  for (const concept of concepts) {
    const members = concept.fields.map((id) => nodes.get(id)).filter((n): n is MapNode => n !== undefined);
    const types = new Map<string, string[]>();
    for (const n of members) {
      const t = normalizedType(typeof n.detail.type === 'string' ? n.detail.type : undefined);
      if (t) types.set(t, [...(types.get(t) ?? []), n.id]);
    }
    if (types.size > 1)
      issues.push({
        kind: 'TYPE_MISMATCH',
        concept: concept.id,
        fields: members.map((n) => n.id),
        message: `${concept.name} : types incompatibles d’une couche à l’autre (${[...types.keys()].join(' / ')})`,
      });
    // Ce qui déclare une règle : un contrôle de formulaire, une classe contrainte (Bean Validation), un
    // schéma de contrat, une colonne (NOT NULL). Un type TypeScript ou une classe sans contrainte ne dit rien.
    const declares = (n: MapNode): boolean =>
      n.kind === 'COLUMN' ||
      (n.layer === 'FRONTEND'
        ? n.parent?.startsWith('COMPONENT:') === true
        : n.layer === 'API' || n.detail.constrained === true);
    const required = members.filter((n) => declares(n) && n.detail.required === true);
    const optional = members.filter((n) => declares(n) && n.detail.required === false && n.kind !== 'COLUMN');
    const layersOf = (list: MapNode[]): string => [...new Set(list.map((n) => n.layer))].join(', ');
    if (required.length > 0 && optional.length > 0)
      issues.push({
        kind: 'VALIDATION_DIVERGENCE',
        concept: concept.id,
        fields: [...required, ...optional].map((n) => n.id),
        message: `${concept.name} : obligatoire dans ${layersOf(required)}, facultatif dans ${layersOf(optional)}`,
      });
    const lengths = [
      ...new Set(members.map((n) => n.detail.maxLength).filter((v): v is number => typeof v === 'number')),
    ];
    if (lengths.length > 1)
      issues.push({
        kind: 'VALIDATION_DIVERGENCE',
        concept: concept.id,
        fields: members.filter((n) => typeof n.detail.maxLength === 'number').map((n) => n.id),
        message: `${concept.name} : longueurs maximales différentes (${lengths.join(' / ')})`,
      });
  }

  // L'opération du contrat qui décrit la cible de chaque corrélation (endpoint servi ou déduit), et les
  // références de cette opération que le contrat ne permet pas de suivre.
  const refCause = (c: MapCorrelation): void => {
    const refs = c.contract ? nodes.get(c.contract)?.detail.unresolvedRefs : undefined;
    if (Array.isArray(refs) && refs.length)
      c.causes.push({
        code: 'REF_UNRESOLVED',
        message: `${nodes.get(c.contract ?? '')?.name ?? ''} : références du contrat non suivies (${refs.join(', ')}) — paramètres ou schémas incomplets`,
      });
  };
  for (const c of correlations) {
    if (!c.target || c.contract) continue;
    if (c.target.startsWith('API:') && nodes.get(c.target)?.layer === 'API') {
      c.contract = c.target;
      refCause(c);
      continue;
    }
    const described = [...edges.values()].find(
      (e) => e.from === c.target && e.kind === 'DEPENDS_ON' && nodes.get(e.to)?.layer === 'API',
    );
    if (described) {
      c.contract = described.to;
      c.steps.push({
        kind: 'CONTRACT',
        label: `décrit par ${nodes.get(described.to)?.name ?? described.to} : ${described.reason}`,
        node: described.to,
      });
      refCause(c);
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    features,
    concepts,
    issues,
    correlations,
    contracts: contractIndex.contracts(),
    contractDiffs: contractIndex.diffs(),
    modules: contractIndex.moduleList(),
    configGraph: buildConfigGraph(input.facts),
  };
}
