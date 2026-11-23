import type { MapLayer } from '../sdk/core/cartography.js';
import type {
  RiskCategory,
  RiskEvidence,
  RiskRuleInfo,
  RiskScenario,
  RiskSeverity,
} from '../sdk/core/risk.js';
import type { Loc, RiskFacts, RiskHolder, RiskSubscription, SourceFacts } from '../cartography/facts.js';
import { callersOf, componentOf, impactOf, type GraphIndex, type ImpactResult } from './impact.js';

/**
 * LE REGISTRE DES RÈGLES. Chaque règle déclare ses prérequis (les faits sans lesquels elle ne conclut pas)
 * et produit des ébauches : entité, emplacement, déclencheur, conditions, preuves (qui soutiennent ou
 * affaiblissent), hypothèses, inconnues, limites. Le moteur en tire la confiance, le statut et l'impact.
 * Aucune règle ne conclut d'après un nom (« reset », « loading ») : seulement d'après les faits lus.
 */
export interface SourceRisk {
  fact: SourceFacts;
  risk: RiskFacts;
  /** La lecture de la source a atteint une limite : une absence ne prouve rien. */
  partial: boolean;
}

export interface RuleContext {
  index: GraphIndex;
  sources: SourceRisk[];
}

export interface Draft {
  ruleId: string;
  sourceId: string;
  layer: MapLayer;
  entity: string;
  /** Ce qui rend l'identifiant stable (membre, méthode) — jamais une ligne. */
  anchor: string;
  node?: string;
  loc: Loc;
  title: string;
  description: string;
  cause: string;
  trigger: string;
  conditions: string[];
  evidence: RiskEvidence[];
  assumptions: string[];
  unknowns: string[];
  /** Une inconnue empêche de conclure : statut INCONCLUSIVE. */
  blocking?: string;
  corroborated: boolean;
  impact?: ImpactResult;
  /** Les fonctionnalités, quand l'impact n'est pas un parcours (couches Java : celles qui atteignent la méthode). */
  features?: ImpactResult['features'];
  severity?: RiskSeverity;
  suggestion: string;
  testPlan?: string[];
  scenario?: RiskScenario;
}

export interface RiskRule extends Omit<RiskRuleInfo, 'enabled'> {
  /** La règle conclut sur une ABSENCE (pas de remise à zéro, pas de libération) : une source partielle la rend inconclusive. */
  absence: boolean;
  limits: string[];
  detect: (ctx: RuleContext) => Draft[];
}

const AST_TS = 'AST TypeScript';
const AST_JAVA = 'AST Java';
const GRAPH = 'graphe de la cartographie';

const ev = (
  src: SourceRisk,
  loc: Loc | undefined,
  text: string,
  reliability: RiskEvidence['reliability'],
  relation: RiskEvidence['relation'] = 'SUPPORTS',
  kind: RiskEvidence['kind'] = 'STATIC_FACT',
  method = src.fact.layer === 'FRONTEND' ? AST_TS : AST_JAVA,
): RiskEvidence => ({
  kind,
  source: src.fact.sourceId,
  ...(loc ? { file: loc.file, line: loc.line } : {}),
  method,
  reliability,
  relation,
  text,
});

const short = (id: string): string => id.split(':').slice(2).join(':') || id;
const stream = (src: string, id: string): string => `STREAM:${src}:${id}`;
const method = (src: string, id: string): string => `METHOD:${src}:${id}`;
const startsOf = (src: string, h: RiskHolder): string[] => [
  stream(src, h.id),
  ...(h.exposedAs ?? []).map((m) => stream(src, `${h.owner}.${m}`)),
];
const kindText: Record<RiskHolder['kind'], string> = {
  BEHAVIOR_SUBJECT: 'BehaviorSubject',
  REPLAY_SUBJECT: 'ReplaySubject',
  SUBJECT: 'Subject',
  SIGNAL: 'signal',
  FIELD: 'champ',
};
const scopeText: Record<RiskHolder['scope'], string> = {
  ROOT: 'fourni à la racine (un seul exemplaire pour toute l’application)',
  PROVIDED: 'fourni par un module ou une route (survit aux écrans de ce périmètre)',
  COMPONENT: 'fourni par un composant (détruit avec lui)',
  UNKNOWN: 'fourni par une portée que le code lu ne démontre pas',
};
/** Retient une valeur pour un nouveau lecteur (un Subject simple ne rejoue rien). */
const retains = (h: RiskHolder): boolean => h.kind !== 'SUBJECT';
const consumerEvidence = (src: SourceRisk, impact: ImpactResult): RiskEvidence[] =>
  impact.consumers.slice(0, 4).map((c) => ({
    kind: 'GRAPH_LINK' as const,
    source: src.fact.sourceId,
    method: GRAPH,
    reliability: c.proven ? ('HIGH' as const) : ('MEDIUM' as const),
    relation: 'SUPPORTS' as const,
    text: `${short(c.component)} lit la donnée (${short(c.via)}) — lien ${c.proven ? 'démontré' : 'probable'}`,
  }));
const componentsOfWriters = (ctx: RuleContext, src: string, writers: readonly string[]): Set<string> => {
  const out = new Set<string>();
  for (const w of writers) for (const c of callersOf(ctx.index, method(src, w))) out.add(c);
  return out;
};
const entryOf = (ctx: RuleContext, src: string, m: string): string | undefined => {
  const entry = ctx.index.nodes.get(method(src, m))?.detail.entry;
  return typeof entry === 'string' ? entry : undefined;
};
const javaMethodNode = (
  ctx: RuleContext,
  src: string,
  file: string,
  cls: string,
  m: string,
): string | undefined => {
  const id = `METHOD:${src}:${file}#${cls}.${m}`;
  return ctx.index.nodes.has(id) ? id : undefined;
};
const featuresReaching = (
  ctx: RuleContext,
  ids: readonly (string | undefined)[],
): ImpactResult['features'] => {
  const out = new Map<string, ImpactResult['features'][number]>();
  for (const id of ids)
    for (const f of id ? (ctx.index.reach.get(id) ?? []) : [])
      if (!out.has(f.id)) out.set(f.id, { id: f.id, name: f.name, confidence: f.confidence, direct: true });
  return [...out.values()];
};

// ── État partagé ───────────────────────────────────────────────────────────────────────────────────────

const STATE_STALE: RiskRule = {
  id: 'RISK-STATE-001',
  category: 'STATE',
  severity: 'MEDIUM',
  type: 'POSSIBLE_STALE_STATE',
  title: 'Donnée obsolète réutilisée après un changement de contexte',
  description:
    'Une donnée gardée par un service qui survit aux écrans est écrite par un parcours et lue par un autre ; aucune remise à zéro n’est lue.',
  prerequisites: [
    'donnée gardée (Subject à valeur, signal, champ)',
    'portée du service',
    'écritures',
    'lecteurs dans le graphe',
  ],
  layers: ['FRONTEND'],
  absence: true,
  limits: [
    'Une remise à zéro faite hors des sources lues (bibliothèque, code généré) n’est pas vue.',
    'L’attendu métier (garder ou effacer la valeur) n’est jamais déduit du code.',
  ],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const sid = src.fact.sourceId;
      for (const h of src.risk.holders) {
        if (h.ownerKind !== 'SERVICE' || h.scope === 'COMPONENT' || !retains(h) || h.persisted) continue;
        const writes = src.risk.writes.filter((w) => w.holder === h.id);
        const values = writes.filter((w) => w.value === 'VALUE');
        if (values.length === 0 || writes.some((w) => w.value === 'RESET')) continue;
        const writers = [...new Set(values.map((w) => w.by))];
        const writerComps = componentsOfWriters(ctx, sid, writers);
        const impact = impactOf(ctx.index, startsOf(sid, h), { exclude: writerComps });
        // Cas I : aucune lecture par un autre parcours, aucune propagation à signaler.
        if (impact.consumers.length === 0) continue;
        const writerFeatures = featuresReaching(ctx, [...writerComps]).map((f) => f.id);
        const elsewhere = impact.features.some((f) => !writerFeatures.includes(f.id));
        const reader = short(impact.consumers[0]?.component ?? '');
        const writerName = writers[0] ?? '';
        out.push({
          ruleId: this.id,
          sourceId: sid,
          layer: src.fact.layer,
          entity: h.id,
          anchor: h.id,
          node: stream(sid, h.id),
          loc: h.loc,
          title: `${h.id} peut garder la valeur d’un parcours précédent`,
          description: `${h.id} (${kindText[h.kind]}) est ${scopeText[h.scope]}. ${writers.join(', ')} y écrit une valeur ; ${impact.consumers.map((c) => short(c.component)).join(', ')} la lit sans l’écrire. Aucune remise à zéro n’est lue.`,
          cause: `La valeur écrite par ${writerName} reste dans ${h.owner} après le changement d’écran ; un lecteur ouvert ensuite reçoit l’ancienne valeur.`,
          trigger: `${reader} s’ouvre après un parcours qui a appelé ${writerName}.`,
          conditions: [
            `${writerName} a été appelé dans un parcours précédent (${[...writerComps].map(short).join(', ') || 'appelant non résolu'})`,
            `${reader} lit ${h.member} sans l’écrire avant`,
            `${h.owner} n’est pas recréé entre les deux (portée ${h.scope})`,
          ],
          evidence: [
            ev(src, h.loc, `${kindText[h.kind]} ${h.id}, ${scopeText[h.scope]}`, 'HIGH'),
            ...values.slice(0, 3).map((w) => ev(src, w.loc, `${w.by} écrit une valeur : ${w.text}`, 'HIGH')),
            ev(
              src,
              h.loc,
              'Aucune remise à zéro lue (next/set à la valeur initiale ou nulle, réaffectation, portée de composant, stockage du navigateur)',
              'MEDIUM',
              'SUPPORTS',
              'ABSENCE',
            ),
            ...consumerEvidence(src, impact),
          ],
          assumptions: ['Le lecteur suppose une valeur propre à son parcours.'],
          unknowns: [
            'L’attendu métier : la valeur doit-elle survivre au changement de parcours ? Il n’est pas déduit du code.',
            ...(h.public
              ? [
                  `${h.id} est public : une autre classe peut le remettre à zéro par un chemin que l’analyse ne résout pas.`,
                ]
              : []),
          ],
          ...(h.public ? { blocking: 'écritures possibles hors de la classe' } : {}),
          corroborated: impact.provenPath && elsewhere,
          impact,
          severity: impact.features.length >= 2 ? 'HIGH' : 'MEDIUM',
          suggestion:
            'Remettre la donnée à zéro quand le contexte change (next(null) ou valeur initiale à la sortie du parcours, ou à l’entrée du lecteur), ou fournir le service au niveau du composant si la donnée lui est propre.',
          testPlan: [
            `Initialiser ${h.owner}.`,
            `Appeler ${writerName} avec une valeur A.`,
            'Changer de contexte (navigation vers un autre parcours).',
            `Initialiser ${reader} pour une valeur B.`,
            `Observer la valeur de ${h.member} lue par ${reader}.`,
            'Vérifier si la valeur A persiste.',
            'Comparer à l’attendu métier (à fournir : la valeur doit-elle être effacée ?).',
          ],
          scenario: { kind: 'STALE_STATE', subject: h.id, writer: writerName, reader },
        });
      }
    }
    return out;
  },
};

const STATE_MUTATION: RiskRule = {
  id: 'RISK-STATE-002',
  category: 'STATE',
  severity: 'MEDIUM',
  type: 'SHARED_MUTATION',
  title: 'Mutation en place d’un état partagé',
  description:
    'La valeur courante d’une donnée partagée est modifiée par référence : ses lecteurs voient l’objet changer sans notification.',
  prerequisites: ['donnée gardée', 'mutation de sa valeur (propriété, méthode modifiante)'],
  layers: ['FRONTEND'],
  absence: false,
  limits: ['Une copie faite par le lecteur (immutabilité volontaire) n’est pas vue.'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const sid = src.fact.sourceId;
      const holders = new Map(src.risk.holders.map((h) => [h.id, h]));
      const seen = new Set<string>();
      for (const w of src.risk.writes) {
        const h = holders.get(w.holder);
        if (w.value !== 'MUTATION' || !h || h.ownerKind !== 'SERVICE' || seen.has(`${h.id}|${w.by}`))
          continue;
        seen.add(`${h.id}|${w.by}`);
        const notified = src.risk.writes.some((x) => x.by === w.by && x.holder === h.id && x.how === 'NEXT');
        const impact = impactOf(ctx.index, startsOf(sid, h));
        out.push({
          ruleId: this.id,
          sourceId: sid,
          layer: src.fact.layer,
          entity: h.id,
          anchor: `${h.id}|${w.by}`,
          node: stream(sid, h.id),
          loc: w.loc,
          title: `${w.by} modifie ${h.id} en place`,
          description: `${w.by} modifie la valeur courante de ${h.id} par référence (${w.text}). Chaque lecteur qui garde cet objet le voit changer${notified ? '' : ', sans nouvelle émission'}.`,
          cause: 'Mutation par référence d’un objet partagé.',
          trigger: `${w.by} est appelé pendant qu’un lecteur garde la valeur.`,
          conditions: [`${w.by} est appelé`, 'un lecteur a reçu la même référence'],
          evidence: [
            ev(src, w.loc, `Mutation en place : ${w.text}`, 'HIGH'),
            ev(src, h.loc, `${kindText[h.kind]} ${h.id}, ${scopeText[h.scope]}`, 'MEDIUM'),
            ...(notified
              ? []
              : [
                  ev(
                    src,
                    w.loc,
                    'Aucune émission après la modification dans la même méthode',
                    'MEDIUM',
                    'SUPPORTS',
                    'ABSENCE',
                  ),
                ]),
            ...consumerEvidence(src, impact),
          ],
          assumptions: ['Les lecteurs n’ont pas copié la valeur.'],
          unknowns: [],
          corroborated: impact.provenPath && !notified,
          impact,
          suggestion: 'Émettre une nouvelle valeur (copie modifiée) au lieu de modifier l’objet courant.',
        });
      }
    }
    return out;
  },
};

const STATE_PARTIAL_RESET: RiskRule = {
  id: 'RISK-STATE-003',
  category: 'STATE',
  severity: 'MEDIUM',
  type: 'INCOMPLETE_RESET',
  title: 'Réinitialisation incomplète',
  description:
    'Une méthode remet à zéro une partie des données écrites ensemble ; les autres restent actives.',
  prerequisites: ['écritures de remise à zéro', 'données écrites ensemble par une même méthode'],
  layers: ['FRONTEND'],
  absence: true,
  limits: ['Garder certaines données peut être voulu : la règle ne le tranche pas.'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const sid = src.fact.sourceId;
      const holders = new Map(src.risk.holders.map((h) => [h.id, h]));
      const resetAnywhere = new Set(src.risk.writes.filter((w) => w.value === 'RESET').map((w) => w.holder));
      const valueBy = new Map<string, Set<string>>();
      for (const w of src.risk.writes)
        if (w.value === 'VALUE') valueBy.set(w.by, new Set([...(valueBy.get(w.by) ?? []), w.holder]));
      const resetters = new Map<string, Set<string>>();
      for (const w of src.risk.writes)
        if (w.value === 'RESET' && holders.get(w.holder)?.ownerKind === 'SERVICE')
          resetters.set(w.by, new Set([...(resetters.get(w.by) ?? []), w.holder]));
      for (const [resetter, reset] of resetters) {
        const together = new Map<string, string>();
        for (const [writer, written] of valueBy)
          if ([...reset].some((h) => written.has(h)))
            for (const h of written) if (!reset.has(h) && !resetAnywhere.has(h)) together.set(h, writer);
        if (together.size === 0) continue;
        const missing = [...together.keys()];
        const first = holders.get(missing[0] ?? '');
        const impact = first ? impactOf(ctx.index, startsOf(sid, first)) : undefined;
        const loc = src.risk.writes.find((w) => w.by === resetter && w.value === 'RESET')?.loc ??
          first?.loc ?? { file: '', line: 0 };
        out.push({
          ruleId: this.id,
          sourceId: sid,
          layer: src.fact.layer,
          entity: resetter,
          anchor: resetter,
          node: method(sid, resetter),
          loc,
          title: `${resetter} remet à zéro ${[...reset].join(', ')} mais pas ${missing.join(', ')}`,
          description: `${resetter} remet à zéro ${[...reset].join(', ')}. ${missing.map((m) => `${m} (écrit avec eux par ${together.get(m) ?? ''})`).join(', ')} n’est remis à zéro nulle part.`,
          cause: 'Des données écrites ensemble ne sont pas effacées ensemble.',
          trigger: `${resetter} est appelé pour revenir à l’état initial.`,
          conditions: [`${resetter} est appelé`, `${missing.join(', ')} garde sa valeur et est lu ensuite`],
          evidence: [
            ...[...reset].map((h) => ev(src, loc, `${resetter} remet ${h} à zéro`, 'HIGH')),
            ...missing.map((m) =>
              ev(
                src,
                holders.get(m)?.loc,
                `${together.get(m) ?? ''} écrit ${m} avec les données remises à zéro`,
                'HIGH',
              ),
            ),
            ev(
              src,
              loc,
              `Aucune remise à zéro de ${missing.join(', ')} lue`,
              'MEDIUM',
              'SUPPORTS',
              'ABSENCE',
            ),
          ],
          assumptions: ['Les données écrites ensemble décrivent le même contexte.'],
          unknowns: ['Garder ces données peut être voulu (attendu métier non déduit du code).'],
          corroborated: false,
          ...(impact ? { impact } : {}),
          suggestion: `Remettre aussi ${missing.join(', ')} à zéro dans ${resetter}, ou documenter pourquoi elles sont gardées.`,
        });
      }
    }
    return out;
  },
};

const STATE_TABS: RiskRule = {
  id: 'RISK-STATE-005',
  category: 'STATE',
  severity: 'MEDIUM',
  type: 'CROSS_TAB_STATE',
  title: 'État conservé d’un onglet à l’autre',
  description:
    'Une donnée écrite depuis un onglet est lue par un autre onglet du même groupe ; elle survit au changement d’onglet.',
  prerequisites: ['onglets du gabarit', 'écrivains et lecteurs de la donnée'],
  layers: ['FRONTEND'],
  absence: false,
  limits: ['Un partage entre onglets peut être voulu (critère commun).'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const sid = src.fact.sourceId;
      if (src.risk.tabs.length < 2) continue;
      const tabOf = new Map(src.risk.tabs.map((t) => [`COMPONENT:${sid}:${t.component}`, t]));
      for (const h of src.risk.holders) {
        if (h.ownerKind !== 'SERVICE' || h.scope === 'COMPONENT' || !retains(h)) continue;
        const values = src.risk.writes.filter((w) => w.holder === h.id && w.value === 'VALUE');
        if (values.length === 0) continue;
        const writerComps = componentsOfWriters(ctx, sid, [...new Set(values.map((w) => w.by))]);
        const impact = impactOf(ctx.index, startsOf(sid, h), { exclude: writerComps });
        for (const w of writerComps) {
          const wt = tabOf.get(w);
          if (!wt) continue;
          const reader = impact.consumers.find((c) => {
            const rt = tabOf.get(c.component);
            return rt && rt.group === wt.group && rt.tab !== wt.tab;
          });
          if (!reader) continue;
          const reset = src.risk.writes.some((x) => x.holder === h.id && x.value === 'RESET');
          out.push({
            ruleId: this.id,
            sourceId: sid,
            layer: src.fact.layer,
            entity: h.id,
            anchor: `${h.id}|${wt.group}`,
            node: stream(sid, h.id),
            loc: h.loc,
            title: `${h.id} passe de l’onglet ${short(wt.tab)} à ${short(tabOf.get(reader.component)?.tab ?? '')}`,
            description: `${short(w)} (onglet ${short(wt.tab)}) écrit ${h.id} ; ${short(reader.component)} (autre onglet du même groupe) la lit. Le changement d’onglet ne la remet pas à zéro.`,
            cause: 'Un état de service partagé par plusieurs onglets.',
            trigger: `L’utilisateur passe de l’onglet ${short(wt.tab)} à l’autre.`,
            conditions: [
              `${short(w)} a écrit ${h.member}`,
              `l’onglet de ${short(reader.component)} est affiché ensuite`,
            ],
            evidence: [
              ev(
                src,
                h.loc,
                `${short(w)} et ${short(reader.component)} sont deux onglets du groupe ${short(wt.group)}`,
                'HIGH',
              ),
              ...values.slice(0, 2).map((x) => ev(src, x.loc, `${x.by} écrit ${h.id}`, 'HIGH')),
              ...consumerEvidence(src, impact),
              ...(reset ? [ev(src, h.loc, `${h.id} est remis à zéro ailleurs`, 'MEDIUM', 'WEAKENS')] : []),
            ],
            assumptions: ['Chaque onglet attend un état propre.'],
            unknowns: ['Le partage peut être voulu (attendu métier non déduit du code).'],
            corroborated: reader.proven && !reset,
            impact,
            suggestion:
              'Garder l’état propre à chaque onglet (service fourni par l’onglet), ou le remettre à zéro au changement d’onglet.',
          });
        }
      }
    }
    return out;
  },
};

const STATE_ALIAS: RiskRule = {
  id: 'RISK-STATE-006',
  category: 'STATE',
  severity: 'MEDIUM',
  type: 'ALIASED_EMISSION',
  title: 'Valeur émise puis modifiée par référence',
  description: 'Une méthode émet un objet puis le modifie : tous les lecteurs partagent la même référence.',
  prerequisites: ['émission d’une variable', 'modification de cette variable après l’émission'],
  layers: ['FRONTEND'],
  absence: false,
  limits: ['Une copie faite dans un opérateur (map) n’est pas vue.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      src.risk.aliases.map((a): Draft => {
        const h = src.risk.holders.find((x) => x.id === a.holder);
        const impact = h ? impactOf(ctx.index, startsOf(src.fact.sourceId, h)) : undefined;
        return {
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: a.holder,
          anchor: `${a.holder}|${a.by}|${a.variable}`,
          node: method(src.fact.sourceId, a.by),
          loc: a.loc,
          title: `${a.by} modifie ${a.variable} après l’avoir émis dans ${a.holder}`,
          description: `${a.by} émet ${a.variable} dans ${a.holder}, puis le modifie (${a.mutation}). Les lecteurs voient la modification sans émission.`,
          cause: 'Alias : la valeur émise et la variable modifiée sont le même objet.',
          trigger: `${a.by} est appelé.`,
          conditions: ['un lecteur garde la valeur émise'],
          evidence: [ev(src, a.loc, `Émission puis modification : ${a.mutation}`, 'HIGH')],
          assumptions: [],
          unknowns: [],
          corroborated: Boolean(impact?.provenPath),
          ...(impact ? { impact } : {}),
          suggestion: 'Émettre une copie, ou finir la construction de l’objet avant de l’émettre.',
        };
      }),
    );
  },
};

// ── Traitements asynchrones ────────────────────────────────────────────────────────────────────────────

const httpTargets = (s: RiskSubscription): string[] => [
  ...s.nextWrites,
  ...s.nextAssigns.map((m) => `${s.owner}.${m}`),
];
const REPEATED: RiskSubscription['sourceKind'][] = ['ROUTE', 'FORM', 'HOLDER', 'EVENT', 'TIMER', 'OTHER'];

const ASYNC_RACE: RiskRule = {
  id: 'RISK-ASYNC-001',
  category: 'ASYNC',
  severity: 'MEDIUM',
  type: 'RACE_CONDITION',
  title: 'Deux traitements asynchrones écrivent la même donnée',
  description:
    'Deux réponses HTTP indépendantes écrivent la même donnée : la dernière arrivée gagne, quel que soit l’ordre des demandes.',
  prerequisites: ['souscriptions HTTP', 'données écrites dans leur suite'],
  layers: ['FRONTEND'],
  absence: false,
  limits: ['Un ordre imposé ailleurs (désactivation de l’interface) n’est pas vu.'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const byTarget = new Map<string, RiskSubscription[]>();
      for (const s of src.risk.subscriptions)
        if (s.sourceKind === 'HTTP')
          for (const t of httpTargets(s)) byTarget.set(t, [...(byTarget.get(t) ?? []), s]);
      for (const [target, subs] of byTarget) {
        const methods = [...new Set(subs.map((s) => s.method))];
        if (methods.length < 2) continue;
        const repeatable = subs.filter(
          (s) => s.nestedIn || entryOf(ctx, src.fact.sourceId, s.method) === 'TEMPLATE',
        );
        out.push({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: target,
          anchor: `${target}|${methods.sort().join(',')}`,
          node: method(src.fact.sourceId, methods[0] ?? ''),
          loc: subs[0]?.loc ?? { file: '', line: 0 },
          title: `${methods.join(' et ')} écrivent ${target} sans ordre garanti`,
          description: `${methods.join(', ')} écrivent ${target} dans la suite de requêtes HTTP indépendantes. Si les deux sont en cours, la réponse arrivée en dernier l’emporte.`,
          cause: 'Aucune coordination (switchMap, file d’attente, annulation) entre les deux traitements.',
          trigger: 'Les deux traitements sont lancés avant la fin du premier.',
          conditions: methods.map((m) => `${m} est appelé`),
          evidence: [
            ...subs
              .slice(0, 3)
              .map((s) => ev(src, s.loc, `${s.method} souscrit ${s.source} et écrit ${target}`, 'HIGH')),
            ...repeatable
              .slice(0, 2)
              .map((s) =>
                ev(
                  src,
                  s.loc,
                  `${s.method} peut être relancé (${s.nestedIn ? `suite de ${s.nestedIn}` : 'appelé par le gabarit'})`,
                  'MEDIUM',
                  'SUPPORTS',
                  'GRAPH_LINK',
                  GRAPH,
                ),
              ),
          ],
          assumptions: ['Les deux réponses n’ont pas le même contenu.'],
          unknowns: ['La latence réelle des deux requêtes.'],
          corroborated: repeatable.length >= 2,
          suggestion: 'Passer par un seul flux (switchMap / concatMap) qui ordonne ou annule les requêtes.',
        });
      }
    }
    return out;
  },
};

const ASYNC_STALE_RESPONSE: RiskRule = {
  id: 'RISK-ASYNC-002',
  category: 'ASYNC',
  severity: 'MEDIUM',
  type: 'STALE_HTTP_RESPONSE',
  title: 'Une réponse HTTP ancienne peut écraser une plus récente',
  description: 'Une requête est relancée sans annuler la précédente ; sa réponse écrit l’état à son arrivée.',
  prerequisites: [
    'souscription HTTP',
    'déclenchement répété (gabarit, suite d’un flux)',
    'écriture dans la suite',
  ],
  layers: ['FRONTEND'],
  absence: false,
  limits: ['Une annulation faite hors de la méthode (garde sur un identifiant de requête) n’est pas vue.'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources)
      for (const s of src.risk.subscriptions) {
        if (s.sourceKind !== 'HTTP' || s.replacesPrevious) continue;
        const entry = entryOf(ctx, src.fact.sourceId, s.method);
        const repeated = s.nestedIn !== undefined && REPEATED.includes(s.nestedIn);
        if (!repeated && entry !== 'TEMPLATE') continue;
        const targets = httpTargets(s).filter(
          (t) => !src.risk.flags.some((f) => `${f.owner}.${f.member}` === t && f.method === s.method),
        );
        if (targets.length === 0) continue;
        out.push({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: s.method,
          anchor: `${s.method}|${s.source}`,
          node: method(src.fact.sourceId, s.method),
          loc: s.loc,
          title: `${s.method} : une réponse ancienne peut écraser ${targets.join(', ')}`,
          description: `${s.method} souscrit ${s.source} ${repeated ? `à chaque émission de ${s.nestedIn}` : 'à chaque appel depuis le gabarit'} sans annuler la requête précédente ; la réponse écrit ${targets.join(', ')} à son arrivée.`,
          cause:
            'Souscriptions HTTP successives non annulées (pas de switchMap, pas de désabonnement de la précédente).',
          trigger: 'Deux déclenchements rapprochés, la première réponse arrive après la seconde.',
          conditions: ['deux déclenchements avant la première réponse', 'la première réponse est plus lente'],
          evidence: [
            ev(src, s.loc, `Souscription ${s.source} sans annulation de la précédente`, 'HIGH'),
            repeated
              ? ev(src, s.loc, `Installée dans la suite de ${s.nestedIn} : une requête par émission`, 'HIGH')
              : {
                  kind: 'GRAPH_LINK',
                  source: src.fact.sourceId,
                  method: GRAPH,
                  reliability: 'MEDIUM',
                  relation: 'SUPPORTS',
                  text: `${s.method} est appelée par le gabarit (peut être relancée)`,
                },
            ev(src, s.loc, `La suite écrit ${targets.join(', ')}`, 'HIGH'),
          ],
          assumptions: ['Les réponses peuvent arriver dans le désordre.'],
          unknowns: ['La fréquence réelle des déclenchements.'],
          corroborated: repeated,
          impact: impactOf(ctx.index, [method(src.fact.sourceId, s.method)]),
          suggestion:
            'Passer la source dans un switchMap (la requête précédente est annulée) ou désabonner la souscription précédente.',
          scenario: {
            kind: 'STALE_RESPONSE',
            subject: targets[0] ?? s.method,
            trigger: s.nestedIn ?? 'gabarit',
            source: s.source,
          },
        });
      }
    return out;
  },
};

const ASYNC_LOST_DISPATCH: RiskRule = {
  id: 'RISK-ASYNC-003',
  category: 'ASYNC',
  severity: 'MEDIUM',
  type: 'LOST_DISPATCH',
  title: 'Action attendue jamais déclenchée en cas d’erreur',
  description:
    'La suite d’une requête met à jour un store ; aucune suite d’erreur ne le fait : après une erreur, rien n’est déclenché ni signalé.',
  prerequisites: [
    'souscription HTTP sans suite d’erreur',
    'appel d’une méthode qui écrit un état dans la suite',
  ],
  layers: ['FRONTEND'],
  absence: true,
  limits: ['Un intercepteur HTTP global peut signaler l’erreur à l’utilisateur (sans relancer l’action).'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const writers = new Set(src.risk.writes.filter((w) => w.value !== 'MUTATION').map((w) => w.by));
      const interceptors = src.fact.ui?.interceptors ?? [];
      for (const s of src.risk.subscriptions) {
        if (s.sourceKind !== 'HTTP' || s.errorHandled) continue;
        const calls = (ctx.index.out.get(method(src.fact.sourceId, s.method)) ?? [])
          .filter((e) => e.kind === 'CALLS')
          .map((e) => short(e.to))
          .filter(
            (t) => writers.has(t) && s.nextCalls.some((c) => t.endsWith(`#${c.split('.').pop() ?? ''}`)),
          );
        if (calls.length === 0) continue;
        out.push({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: s.method,
          anchor: `${s.method}|${calls.join(',')}`,
          node: method(src.fact.sourceId, s.method),
          loc: s.loc,
          title: `${s.method} : ${calls.join(', ')} n’est pas appelé si la requête échoue`,
          description: `${s.method} souscrit ${s.source} ; seule la suite de succès appelle ${calls.join(', ')}. Aucune suite d’erreur : l’état reste celui d’avant, sans signal.`,
          cause: 'Pas de rappel error ni de catchError sur la requête.',
          trigger: 'La requête échoue (réseau, 4xx, 5xx).',
          conditions: ['la requête échoue'],
          evidence: [
            ev(src, s.loc, `Souscription ${s.source} sans suite d’erreur`, 'HIGH', 'SUPPORTS', 'ABSENCE'),
            ev(src, s.loc, `La suite de succès appelle ${calls.join(', ')} (écrit un état)`, 'HIGH'),
            ...interceptors
              .slice(0, 1)
              .map((i) =>
                ev(
                  src,
                  i.loc,
                  `Intercepteur HTTP ${i.name} : l’erreur peut être signalée globalement`,
                  'MEDIUM',
                  'WEAKENS',
                ),
              ),
          ],
          assumptions: ['L’état attendu après l’action dépend de cet appel.'],
          unknowns: [],
          corroborated: interceptors.length === 0,
          impact: impactOf(ctx.index, [method(src.fact.sourceId, s.method)]),
          suggestion:
            'Ajouter une suite d’erreur (rappel error ou catchError) qui remet l’état et informe l’utilisateur.',
        });
      }
    }
    return out;
  },
};

const ASYNC_BROKEN_CHAIN: RiskRule = {
  id: 'RISK-ASYNC-004',
  category: 'ASYNC',
  severity: 'HIGH',
  type: 'BROKEN_CHAIN',
  title: 'Une erreur termine un flux longue durée',
  description:
    'Un flux longue durée (effet, flux d’actions) appelle HTTP par un opérateur d’aplatissement sans rattraper l’erreur dans le flux interne : la première erreur le termine, les émissions suivantes sont ignorées.',
  prerequisites: [
    'pipe d’un flux longue durée',
    'opérateur d’aplatissement vers HTTP',
    'absence de catchError interne',
  ],
  layers: ['FRONTEND'],
  absence: true,
  limits: ['Un flux recréé à chaque utilisation (souscription courte) est moins exposé.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      src.risk.pipes
        .filter((p) => !p.catchInner)
        .map((p): Draft => {
          const sid = src.fact.sourceId;
          const node = p.at.includes('#') ? method(sid, p.at) : stream(sid, p.at);
          const impact = impactOf(ctx.index, [node]);
          const dispatchers = [...(ctx.index.in.get(node) ?? [])]
            .filter((e) => e.kind === 'CALLS')
            .map((e) => short(e.from));
          return {
            ruleId: this.id,
            sourceId: sid,
            layer: src.fact.layer,
            entity: p.at,
            anchor: p.at,
            node,
            loc: p.loc,
            title: `${p.at} s’arrête à la première erreur HTTP`,
            description: `${p.at} = ${p.source}.pipe(${p.operators.join(', ')}). L’appel HTTP dans ${p.flatten} n’a pas de catchError interne${p.catchOuter ? ' (un catchError après l’aplatissement rattrape l’erreur mais termine quand même le flux)' : ''} : après une erreur, ${p.at} est terminé et les émissions suivantes de ${p.source} ne sont plus traitées.`,
            cause:
              'Une erreur non rattrapée dans le flux interne se propage au flux externe, qui se termine.',
            trigger: 'Une requête de la chaîne échoue une fois.',
            conditions: ['une requête échoue', 'une nouvelle émission arrive ensuite'],
            evidence: [
              ev(src, p.loc, `Opérateurs : ${p.operators.join(' → ')}`, 'HIGH'),
              ev(
                src,
                p.loc,
                `Aucun catchError dans le flux interne de ${p.flatten}`,
                'HIGH',
                'SUPPORTS',
                'ABSENCE',
              ),
              ...(p.catchOuter
                ? [
                    ev(
                      src,
                      p.loc,
                      'catchError placé après l’aplatissement : le flux externe se termine',
                      'HIGH',
                    ),
                  ]
                : []),
              ...dispatchers.slice(0, 2).map((d) => ({
                kind: 'GRAPH_LINK' as const,
                source: sid,
                method: GRAPH,
                reliability: 'HIGH' as const,
                relation: 'SUPPORTS' as const,
                text: `${d} alimente ce flux (dispatch, émission)`,
              })),
            ],
            assumptions: [],
            unknowns: [],
            corroborated: true,
            impact,
            severity: 'HIGH',
            suggestion: `Rattraper l’erreur dans le flux interne : ${p.flatten}(x => appel(x).pipe(catchError(...))).`,
            testPlan: [
              `Souscrire ${p.at}.`,
              `Émettre sur ${p.source} une première action dont la requête échoue (réponse HTTP simulée en erreur).`,
              'Émettre une seconde action dont la requête réussit.',
              'Vérifier que la seconde réponse n’est jamais reçue (le flux est terminé).',
            ],
            scenario: { kind: 'BROKEN_CHAIN', subject: p.at, source: p.source, trigger: p.flatten },
          };
        }),
    );
  },
};

const ASYNC_LOADING: RiskRule = {
  id: 'RISK-ASYNC-006',
  category: 'ASYNC',
  severity: 'HIGH',
  type: 'LOADING_STUCK_AFTER_ERROR',
  title: 'Indicateur resté actif après une erreur',
  description:
    'Un membre posé à vrai avant un traitement asynchrone ne revient à faux que dans la suite de succès.',
  prerequisites: ['membre posé à vrai', 'retour à faux seulement dans la suite de succès'],
  layers: ['FRONTEND'],
  absence: true,
  limits: ['Une remise faite par un autre composant ou un intercepteur n’est pas vue.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      src.risk.flags
        .filter(
          (f) => !f.resets.some((r) => r === 'ERROR' || r === 'FINALIZE' || r === 'FINALLY' || r === 'CATCH'),
        )
        .map((f): Draft => {
          const sid = src.fact.sourceId;
          const node = method(sid, f.method);
          // Le gabarit lit ce membre (condition d'affichage ou d'activation qui dépend de la méthode).
          const used = (ctx.index.in.get(node) ?? []).filter(
            (e) =>
              e.kind === 'DEPENDS_ON' &&
              ctx.index.nodes.get(e.from)?.kind === 'CONDITION' &&
              e.reason.includes(f.member),
          );
          const impact = impactOf(ctx.index, [node, ...used.map((e) => e.from)]);
          return {
            ruleId: this.id,
            sourceId: sid,
            layer: src.fact.layer,
            entity: `${f.owner}.${f.member}`,
            anchor: `${f.method}|${f.member}`,
            node,
            loc: f.loc,
            title: `${f.owner}.${f.member} reste vrai si ${f.method} échoue`,
            description: `${f.method} pose ${f.member} à vrai puis attend une réponse (${f.via === 'SUBSCRIBE' ? 'subscribe' : f.via === 'AWAIT' ? 'await' : 'then'}). ${f.member} ne revient à faux que dans la suite de succès : après une erreur il reste vrai${used.length ? ` et ${used.map((e) => short(e.from)).join(', ')} reste bloqué` : ''}.`,
            cause: 'Pas de remise dans la suite d’erreur, ni finalize, ni finally.',
            trigger: 'La requête échoue.',
            conditions: ['la requête échoue'],
            evidence: [
              ev(src, f.loc, `${f.member} = true avant le traitement asynchrone`, 'HIGH'),
              ev(src, f.loc, `${f.member} = false seulement dans : ${f.resets.join(', ')}`, 'HIGH'),
              ev(
                src,
                f.loc,
                f.errorPath
                  ? 'Une suite d’erreur existe mais ne remet pas le membre'
                  : 'Aucune suite d’erreur',
                'HIGH',
                'SUPPORTS',
                'ABSENCE',
              ),
              ...used.slice(0, 2).map((e) => ({
                kind: 'GRAPH_LINK' as const,
                source: sid,
                method: GRAPH,
                reliability: 'HIGH' as const,
                relation: 'SUPPORTS' as const,
                text: `Le gabarit dépend de ${f.member} : ${short(e.from)}`,
              })),
            ],
            assumptions: ['Le membre décrit une requête en cours.'],
            unknowns: [],
            corroborated: used.length > 0,
            impact,
            severity: 'HIGH',
            suggestion: `Remettre ${f.member} à faux dans tous les cas : finalize(() => this.${f.member} = false) ou finally.`,
            testPlan: [
              `Créer ${f.owner} avec une réponse HTTP simulée en erreur.`,
              `Appeler ${f.method.split('#')[1] ?? f.method}().`,
              `Vérifier que ${f.member} vaut toujours vrai après l’erreur.`,
            ],
            scenario: {
              kind: 'LOADING_FLAG',
              subject: `${f.owner}.${f.member}`,
              trigger: f.method,
              source: f.via,
            },
          };
        }),
    );
  },
};

const BOUNDED = [
  'take',
  'first',
  'takeUntil',
  'takeUntilDestroyed',
  'takeWhile',
  'single',
  'unsubscribe',
  'subscription-bag',
];

const ASYNC_REPEATED: RiskRule = {
  id: 'RISK-ASYNC-007',
  category: 'ASYNC',
  severity: 'MEDIUM',
  type: 'DUPLICATE_EXECUTION',
  title: 'Traitement exécuté plusieurs fois',
  description:
    'Une méthode relancée depuis le gabarit installe à chaque appel une nouvelle souscription à un flux qui dure : le traitement s’exécute une fois de plus à chaque appel.',
  prerequisites: [
    'souscription à un flux longue durée',
    'méthode appelée par le gabarit',
    'souscription non bornée',
  ],
  layers: ['FRONTEND'],
  absence: true,
  limits: [],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources)
      for (const s of src.risk.subscriptions) {
        if (s.sourceKind === 'HTTP' || s.sourceKind === 'ROUTE') continue;
        if (s.cleanup.some((c) => BOUNDED.includes(c))) continue;
        if (entryOf(ctx, src.fact.sourceId, s.method) !== 'TEMPLATE') continue;
        out.push({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: s.method,
          anchor: `${s.method}|${s.source}`,
          node: method(src.fact.sourceId, s.method),
          loc: s.loc,
          title: `${s.method} ajoute une souscription à ${s.source} à chaque appel`,
          description: `${s.method} est appelée depuis le gabarit et souscrit ${s.source} sans borne : au N-ième appel, chaque émission exécute le traitement N fois.`,
          cause: 'Souscription installée dans une méthode répétable au lieu de l’initialisation.',
          trigger: `${s.method} est appelée plusieurs fois.`,
          conditions: [`${s.method} est appelée plus d’une fois`, `${s.source} émet ensuite`],
          evidence: [
            ev(src, s.loc, `Souscription non bornée à ${s.source}`, 'HIGH', 'SUPPORTS', 'ABSENCE'),
            {
              kind: 'GRAPH_LINK',
              source: src.fact.sourceId,
              method: GRAPH,
              reliability: 'HIGH',
              relation: 'SUPPORTS',
              text: `${s.method} est appelée par le gabarit`,
            },
          ],
          assumptions: [],
          unknowns: [],
          corroborated: s.sourceKind === 'HOLDER',
          impact: impactOf(ctx.index, [method(src.fact.sourceId, s.method)]),
          suggestion:
            'Souscrire une seule fois (initialisation, pipe async) ou borner la souscription (take(1)).',
        });
      }
    return out;
  },
};

// ── Ressources ─────────────────────────────────────────────────────────────────────────────────────────

const CLEAN_SUBSCRIPTION: RiskRule = {
  id: 'RISK-CLEAN-001',
  category: 'CLEANUP',
  severity: 'MEDIUM',
  type: 'SUBSCRIPTION_LEAK',
  title: 'Souscription qui survit au composant',
  description:
    'Un composant souscrit un flux qui dure plus que lui, sans mécanisme de fin : le rappel continue après la destruction.',
  prerequisites: ['souscription d’un composant', 'source longue durée', 'absence de mécanisme de nettoyage'],
  layers: ['FRONTEND'],
  absence: true,
  limits: [
    'Les flux d’ActivatedRoute (terminés par Angular à la destruction) et les requêtes HTTP (qui se terminent) sont exclus.',
    'Un nettoyage délégué à une autre classe n’est pas vu.',
  ],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const holders = new Map(src.risk.holders.map((h) => [h.id, h]));
      for (const s of src.risk.subscriptions) {
        if (s.ownerKind !== 'COMPONENT' || s.cleanup.length > 0) continue;
        if (s.sourceKind === 'HTTP' || s.sourceKind === 'ROUTE') continue;
        const h = s.holder ? holders.get(s.holder) : undefined;
        if (h && h.owner === s.owner) continue;
        const outlives = h ? h.scope !== 'COMPONENT' : s.sourceKind === 'TIMER' || s.sourceKind === 'EVENT';
        out.push({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: s.method,
          anchor: `${s.method}|${s.source}`,
          node: method(src.fact.sourceId, s.method),
          loc: s.loc,
          title: `${s.owner} : la souscription à ${s.source} n’est jamais libérée`,
          description: `${s.method} souscrit ${s.source}${h ? ` (${h.id}, ${scopeText[h.scope]})` : ''} sans takeUntil, takeUntilDestroyed, take, unsubscribe ni pipe async. Après la destruction de ${s.owner}, le rappel continue de s’exécuter.`,
          cause: 'Aucun mécanisme de fin de souscription.',
          trigger: `${s.owner} est détruit puis ${s.source} émet.`,
          conditions: [`${s.owner} est détruit`, `${s.source} émet ensuite`],
          evidence: [
            ev(
              src,
              s.loc,
              `Souscription à ${s.source} sans mécanisme de fin (aucun opérateur de borne, aucun désabonnement)`,
              'HIGH',
              'SUPPORTS',
              'ABSENCE',
            ),
            ...(h ? [ev(src, h.loc, `${h.id} est ${scopeText[h.scope]}`, 'HIGH')] : []),
          ],
          assumptions: [],
          unknowns: outlives ? [] : ['La durée de vie de la source n’est pas démontrée.'],
          corroborated: outlives,
          severity: outlives ? 'MEDIUM' : 'LOW',
          suggestion:
            'Borner la souscription : takeUntilDestroyed(), pipe async dans le gabarit, ou unsubscribe() dans ngOnDestroy.',
          testPlan: [
            `Créer puis détruire ${s.owner}.`,
            `Émettre sur ${s.source}.`,
            'Vérifier que le rappel du composant détruit s’exécute encore.',
          ],
          scenario: { kind: 'SUBSCRIPTION_LEAK', subject: s.method, source: s.source },
        });
      }
    }
    return out;
  },
};

const CLEAN_RESOURCE: RiskRule = {
  id: 'RISK-CLEAN-002',
  category: 'CLEANUP',
  severity: 'MEDIUM',
  type: 'RESOURCE_NOT_RELEASED',
  title: 'Ressource non libérée',
  description:
    'Un composant ouvre un écouteur, une minuterie, un observateur ou une socket que la classe ne libère jamais.',
  prerequisites: ['ouverture d’une ressource dans un composant', 'absence de libération dans la classe'],
  layers: ['FRONTEND'],
  absence: true,
  limits: ['Une libération faite par un autre objet n’est pas vue.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      src.risk.resources
        .filter((r) => !r.released && r.ownerKind === 'COMPONENT')
        .map((r): Draft => ({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: r.method,
          anchor: `${r.method}|${r.kind}|${r.target}`,
          node: method(src.fact.sourceId, r.method),
          loc: r.loc,
          title: `${r.owner} : ${r.target} n’est jamais libéré`,
          description: `${r.method} ouvre ${r.target} (${r.kind.toLowerCase()}) ; aucune libération (${r.kind === 'LISTENER' ? 'removeEventListener' : r.kind === 'INTERVAL' ? 'clearInterval' : r.kind === 'OBSERVER' ? 'disconnect' : 'close'}) n’est lue dans ${r.owner}.`,
          cause: 'Ressource ouverte sans libération.',
          trigger: `${r.owner} est détruit.`,
          conditions: [`${r.owner} est créé puis détruit`],
          evidence: [
            ev(src, r.loc, `${r.target} ouvert dans ${r.method}`, 'HIGH'),
            ev(src, r.loc, 'Aucune libération dans la classe', 'HIGH', 'SUPPORTS', 'ABSENCE'),
          ],
          assumptions: [],
          unknowns: [],
          corroborated: r.kind === 'INTERVAL' || /\b(window|document)\b/.test(r.target),
          suggestion: 'Libérer la ressource dans ngOnDestroy (ou DestroyRef.onDestroy).',
        })),
    );
  },
};

// ── Erreurs ────────────────────────────────────────────────────────────────────────────────────────────

const ERR_UNHANDLED: RiskRule = {
  id: 'RISK-ERR-001',
  category: 'ERROR',
  severity: 'LOW',
  type: 'UNHANDLED_HTTP_ERROR',
  title: 'Erreur HTTP sans traitement local',
  description:
    'Une requête d’un composant n’a ni rappel error ni catchError : l’état après une erreur n’est pas défini localement.',
  prerequisites: ['souscription HTTP d’un composant sans suite d’erreur'],
  layers: ['FRONTEND'],
  absence: true,
  limits: ['Un intercepteur ou un gestionnaire global peut traiter l’erreur.'],
  detect(ctx) {
    const out: Draft[] = [];
    for (const src of ctx.sources) {
      const interceptors = src.fact.ui?.interceptors ?? [];
      const flagged = new Set(src.risk.flags.map((f) => f.method));
      for (const s of src.risk.subscriptions) {
        if (s.sourceKind !== 'HTTP' || s.errorHandled || s.ownerKind !== 'COMPONENT' || flagged.has(s.method))
          continue;
        out.push({
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: s.method,
          anchor: `${s.method}|${s.source}`,
          node: method(src.fact.sourceId, s.method),
          loc: s.loc,
          title: `${s.method} : aucune suite d’erreur pour ${s.source}`,
          description: `${s.method} souscrit ${s.source} sans rappel error ni catchError.`,
          cause: 'Erreur non traitée localement.',
          trigger: 'La requête échoue.',
          conditions: ['la requête échoue'],
          evidence: [
            ev(src, s.loc, 'Ni rappel error, ni catchError, ni retry', 'HIGH', 'SUPPORTS', 'ABSENCE'),
            ...interceptors
              .slice(0, 1)
              .map((i) => ev(src, i.loc, `Intercepteur HTTP ${i.name}`, 'MEDIUM', 'WEAKENS')),
          ],
          assumptions: [],
          unknowns: interceptors.length
            ? []
            : ['Un gestionnaire d’erreurs global (ErrorHandler) n’est pas recherché.'],
          corroborated: false,
          suggestion: 'Ajouter une suite d’erreur qui garde un état cohérent et informe l’utilisateur.',
        });
      }
    }
    return out;
  },
};

// ── Couches Java ───────────────────────────────────────────────────────────────────────────────────────

const BE_SHARED_STATE: RiskRule = {
  id: 'RISK-BE-001',
  category: 'BACKEND',
  severity: 'HIGH',
  type: 'SHARED_MUTABLE_STATE',
  title: 'État modifiable partagé entre requêtes',
  description:
    'Un bean singleton garde un champ modifiable écrit pendant le traitement d’une requête : les requêtes concurrentes se le partagent.',
  prerequisites: [
    'bean singleton (stéréotype Spring, portée par défaut)',
    'champ ni final ni injecté',
    'écriture hors du constructeur',
  ],
  layers: ['BFF', 'BACKEND'],
  absence: false,
  limits: ['Une synchronisation (mutex, type atomique) n’est pas analysée.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      (src.risk.java?.mutable ?? []).map((f): Draft => {
        const nodes = f.writers.map((w) => javaMethodNode(ctx, src.fact.sourceId, f.loc.file, f.cls, w));
        return {
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: `${f.cls}.${f.field}`,
          anchor: `${f.cls}.${f.field}`,
          ...(nodes[0] ? { node: nodes[0] } : {}),
          loc: f.loc,
          title: `${f.cls}.${f.field} est partagé entre les requêtes`,
          description: `${f.cls} (@${f.stereotype}, singleton) garde ${f.field} (${f.type}), écrit par ${f.writers.join(', ')} à chaque appel. Deux requêtes simultanées s’écrasent mutuellement la valeur.`,
          cause: 'État de requête stocké dans un bean singleton.',
          trigger: 'Deux requêtes traitées en même temps.',
          conditions: [
            'requêtes concurrentes',
            `${f.writers.join(', ')} lit ou renvoie ${f.field} après l’écriture d’une autre requête`,
          ],
          evidence: [
            ev(src, f.loc, `@${f.stereotype} sans @Scope : un seul exemplaire`, 'HIGH'),
            ev(src, f.loc, `${f.field} n’est ni final ni injecté`, 'HIGH'),
            ev(src, f.loc, `Écrit par ${f.writers.join(', ')}`, 'HIGH'),
          ],
          assumptions: ['Le serveur traite les requêtes sur plusieurs fils.'],
          unknowns: [],
          corroborated: true,
          features: featuresReaching(ctx, nodes),
          suggestion:
            'Garder la donnée dans une variable locale ou un objet de requête, jamais dans un champ du bean.',
        };
      }),
    );
  },
};

const BE_SWALLOWED: RiskRule = {
  id: 'RISK-BE-002',
  category: 'BACKEND',
  severity: 'MEDIUM',
  type: 'SWALLOWED_EXCEPTION',
  title: 'Exception rattrapée sans suite',
  description:
    'Une exception est rattrapée puis ignorée (bloc vide, journal seul, retour null) : l’appelant continue avec un état incomplet.',
  prerequisites: ['bloc catch sans throw'],
  layers: ['BFF', 'BACKEND'],
  absence: false,
  limits: ['Le traitement de null par l’appelant n’est pas suivi.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      (src.risk.java?.swallowed ?? []).map((x): Draft => {
        const node = javaMethodNode(ctx, src.fact.sourceId, x.loc.file, x.cls, x.method);
        return {
          ruleId: this.id,
          sourceId: src.fact.sourceId,
          layer: src.fact.layer,
          entity: `${x.cls}.${x.method}`,
          anchor: `${x.cls}.${x.method}|${x.exception}`,
          ...(node ? { node } : {}),
          loc: x.loc,
          title: `${x.cls}.${x.method} ignore ${x.exception}`,
          description: `${x.cls}.${x.method} rattrape ${x.exception} ${x.how === 'EMPTY' ? 'dans un bloc vide' : x.how === 'LOG_ONLY' ? 'et se contente de la journaliser' : 'et renvoie null'} : l’erreur ne remonte pas.`,
          cause: 'Erreur masquée.',
          trigger: `${x.exception} est levée.`,
          conditions: [`${x.exception} est levée dans ${x.method}`],
          evidence: [ev(src, x.loc, `catch (${x.exception}) : ${x.how}`, 'HIGH')],
          assumptions: ['L’appelant suppose une réponse complète.'],
          unknowns: ['Le comportement de l’appelant face à l’absence de résultat.'],
          corroborated: false,
          features: featuresReaching(ctx, [node]),
          suggestion:
            'Relancer une exception métier (ou renvoyer une réponse d’erreur explicite) au lieu de masquer l’erreur.',
        };
      }),
    );
  },
};

const BE_TRANSACTION: RiskRule = {
  id: 'RISK-BE-003',
  category: 'BACKEND',
  severity: 'HIGH',
  type: 'INCOMPLETE_TRANSACTION',
  title: 'Écritures multiples sans transaction',
  description:
    'Une méthode de service écrit plusieurs fois en base sans @Transactional : un échec entre deux écritures laisse la base à moitié modifiée.',
  prerequisites: [
    'plusieurs écritures en base dans une méthode',
    'absence de @Transactional (méthode ou classe)',
  ],
  layers: ['BFF', 'BACKEND'],
  absence: true,
  limits: ['Une transaction ouverte par l’appelant n’est pas suivie.'],
  detect(ctx) {
    return ctx.sources.flatMap((src) =>
      (src.risk.java?.writes ?? [])
        .filter((w) => !w.transactional)
        .map((w): Draft => {
          const node = javaMethodNode(ctx, src.fact.sourceId, w.loc.file, w.cls, w.method);
          const features = featuresReaching(ctx, [node]);
          return {
            ruleId: this.id,
            sourceId: src.fact.sourceId,
            layer: src.fact.layer,
            entity: `${w.cls}.${w.method}`,
            anchor: `${w.cls}.${w.method}`,
            ...(node ? { node } : {}),
            loc: w.loc,
            title: `${w.cls}.${w.method} écrit ${String(w.calls.length)} fois sans transaction`,
            description: `${w.cls}.${w.method} appelle ${w.calls.join(', ')} sans @Transactional : si la deuxième écriture échoue, la première reste.`,
            cause: 'Plusieurs écritures hors transaction.',
            trigger: 'Une écriture échoue après une autre.',
            conditions: ['une écriture échoue après une précédente'],
            evidence: [
              ev(src, w.loc, `Écritures : ${w.calls.join(', ')}`, 'HIGH'),
              ev(
                src,
                w.loc,
                'Aucun @Transactional sur la méthode ni sur la classe',
                'HIGH',
                'SUPPORTS',
                'ABSENCE',
              ),
            ],
            assumptions: ['Les deux écritures doivent réussir ou échouer ensemble.'],
            unknowns: ['Une transaction ouverte par l’appelant.'],
            corroborated: false,
            features,
            suggestion:
              'Annoter la méthode @Transactional (ou regrouper les écritures dans une méthode transactionnelle).',
          };
        }),
    );
  },
};

/** Le registre, dans l'ordre d'exécution. */
export const RULES: readonly RiskRule[] = [
  STATE_STALE,
  STATE_MUTATION,
  STATE_PARTIAL_RESET,
  STATE_TABS,
  STATE_ALIAS,
  ASYNC_RACE,
  ASYNC_STALE_RESPONSE,
  ASYNC_LOST_DISPATCH,
  ASYNC_BROKEN_CHAIN,
  ASYNC_LOADING,
  ASYNC_REPEATED,
  CLEAN_SUBSCRIPTION,
  CLEAN_RESOURCE,
  ERR_UNHANDLED,
  BE_SHARED_STATE,
  BE_SWALLOWED,
  BE_TRANSACTION,
];

export function ruleInfo(rule: RiskRule, enabled: boolean): RiskRuleInfo {
  return {
    id: rule.id,
    category: rule.category satisfies RiskCategory,
    severity: rule.severity,
    type: rule.type,
    title: rule.title,
    description: rule.description,
    prerequisites: rule.prerequisites,
    layers: rule.layers,
    enabled,
  };
}

export { componentOf };
