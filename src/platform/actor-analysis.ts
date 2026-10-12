import type { Access, AuthorizationReport } from '../actors/authorization-observer.js';
import type { ActorProfile } from '../config/config.js';
import type { ActorAccessMemory } from '../knowledge/knowledge-model.js';
import type { SessionReport } from '../auth/session-provider.js';
import type { Finding } from './model.js';

/**
 * ACTOR ANALYSIS (ActorProfile + ActorBehaviorDiff) : ce que chaque acteur a atteint, confronté
 * à son profil déclaré, aux règles de la mission et à ce qu'il atteignait au run précédent.
 *
 * Ce qui existait : l'AuthorizationObserver (chaque acteur ouvre les écrans trouvés), ses
 * différences d'accès et ses règles PASS/FAIL, les sessions réutilisables (phase 4). Ce qui est
 * nouveau : le profil d'acteur (rôles, permissions, noms de revendications, locataire), la
 * classification de chaque différence (attendue par une règle, inattendue, inconnue) et l'ÉCART
 * DE COMPORTEMENT avec le run précédent (connaissance) : un écran permis hier et refusé
 * aujourd'hui est une POSSIBLE_AUTHORIZATION_REGRESSION — possible, jamais certaine : seule une
 * règle de la mission en fait un échec.
 */

export type DifferenceClassification = 'EXPECTED_BY_RULE' | 'UNEXPECTED' | 'UNKNOWN';

export type BehaviorChange =
  | 'POSSIBLE_AUTHORIZATION_REGRESSION'
  | 'ACCESS_NEWLY_GRANTED'
  | 'ACCESS_CHANGED'
  | 'UNCHANGED'
  | 'NEW_SCREEN';

export interface ActorSummary {
  name: string;
  primary: boolean;
  profile?: ActorProfile;
  session?: SessionReport;
  reached: number;
  denied: number;
  notFound: number;
  errors: number;
  /** L'acteur n'a pas pu se connecter (message sans secret). */
  loginError?: string;
}

export interface ActorDifference {
  stateId: string;
  label: string;
  url: string;
  access: Record<string, Access>;
  classification: DifferenceClassification;
  /** La règle qui l'attendait (actor → path expect …). */
  rule?: string;
}

export interface ActorBehaviorDiff {
  actor: string;
  stateId: string;
  label: string;
  previous: string;
  current: Access;
  change: BehaviorChange;
  previousRun: string;
}

export interface ActorAnalysis {
  primaryActor: string;
  actors: ActorSummary[];
  differences: ActorDifference[];
  rules: AuthorizationReport['rules'];
  behaviorDiff: ActorBehaviorDiff[];
  /** La mémoire à garder pour le run suivant : accès de chaque acteur par écran. */
  memory: Record<string, Record<string, ActorAccessMemory>>;
  findings: Finding[];
  summary: {
    actors: number;
    differences: number;
    unexpectedDifferences: number;
    rulesFailed: number;
    possibleRegressions: number;
  };
}

function pathMatches(pattern: string, url: string): boolean {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // URL relative ou masquée : comparée telle quelle
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(pathname);
}

/** L'analyse des acteurs ; `previous` est la mémoire du run précédent (connaissance), `runId` celui-ci. */
export function analyzeActors(
  report: AuthorizationReport,
  previous: Record<string, Record<string, ActorAccessMemory>>,
  runId: string,
  at: string,
): ActorAnalysis {
  const observations = report.observations;
  const actors: ActorSummary[] = report.actors.map((name) => {
    const own = observations.filter((entry) => entry.actor === name);
    const profile = report.profiles?.[name];
    const session = report.sessions?.[name];
    const error = report.errors.find((entry) => entry.actor === name);
    return {
      name,
      primary: name === report.primaryActor,
      ...(profile ? { profile } : {}),
      ...(session ? { session } : {}),
      reached: own.filter((entry) => entry.access === 'ALLOWED').length,
      denied: own.filter((entry) => entry.access === 'DENIED').length,
      notFound: own.filter((entry) => entry.access === 'NOT_FOUND').length,
      errors: own.filter((entry) => entry.access === 'ERROR').length,
      ...(error ? { loginError: error.message } : {}),
    };
  });
  const differences: ActorDifference[] = report.differences.map((difference) => {
    const rule = report.rules.find(
      (entry) =>
        pathMatches(entry.path, difference.url) &&
        difference.access[entry.actor] !== undefined &&
        (entry.expect === 'denied') === (difference.access[entry.actor] === 'DENIED'),
    );
    return {
      stateId: difference.stateId,
      label: difference.label,
      url: difference.url,
      access: difference.access,
      classification: rule ? 'EXPECTED_BY_RULE' : report.rules.length > 0 ? 'UNEXPECTED' : 'UNKNOWN',
      ...(rule ? { rule: `${rule.actor} → ${rule.path} expected ${rule.expect}` } : {}),
    };
  });
  const memory: ActorAnalysis['memory'] = {};
  const behaviorDiff: ActorBehaviorDiff[] = [];
  for (const observation of observations) {
    const key = observation.url;
    (memory[observation.actor] ??= {})[key] = {
      access: observation.access,
      label: observation.label,
      runId,
      at,
    };
    const before = previous[observation.actor]?.[key];
    if (!before) {
      if (Object.keys(previous).length > 0)
        behaviorDiff.push({
          actor: observation.actor,
          stateId: observation.stateId,
          label: observation.label,
          previous: 'NOT_SEEN',
          current: observation.access,
          change: 'NEW_SCREEN',
          previousRun: '',
        });
      continue;
    }
    const change: BehaviorChange =
      before.access === observation.access
        ? 'UNCHANGED'
        : before.access === 'ALLOWED' && observation.access === 'DENIED'
          ? 'POSSIBLE_AUTHORIZATION_REGRESSION'
          : before.access === 'DENIED' && observation.access === 'ALLOWED'
            ? 'ACCESS_NEWLY_GRANTED'
            : 'ACCESS_CHANGED';
    if (change !== 'UNCHANGED')
      behaviorDiff.push({
        actor: observation.actor,
        stateId: observation.stateId,
        label: observation.label,
        previous: before.access,
        current: observation.access,
        change,
        previousRun: before.runId,
      });
  }
  const possibleRegressions = behaviorDiff.filter(
    (entry) => entry.change === 'POSSIBLE_AUTHORIZATION_REGRESSION',
  );
  const unexpected = differences.filter((entry) => entry.classification === 'UNEXPECTED');
  const failedRules = report.rules.filter((rule) => rule.status === 'FAIL');
  const findings: Finding[] = [
    ...failedRules.map((rule): Finding => ({
      conclusion: `authorization rule failed: ${rule.actor} → ${rule.path} expected ${rule.expect}`,
      evidence: rule.violations,
      confidence: 1,
      source: 'RUNTIME',
    })),
    ...possibleRegressions.map((entry): Finding => ({
      conclusion: `possible authorization regression: ${entry.actor} reached "${entry.label}" in run ${entry.previousRun}, denied now`,
      evidence: [`previous ${entry.previous}`, `current ${entry.current}`],
      confidence: 0.6,
      source: 'HISTORICAL',
    })),
    ...unexpected.slice(0, 10).map((entry): Finding => ({
      conclusion: `access differs on "${entry.label}" and no rule expects it`,
      evidence: Object.entries(entry.access).map(([actor, access]) => `${actor}: ${access}`),
      confidence: 0.5,
      source: 'RUNTIME',
    })),
  ];
  return {
    primaryActor: report.primaryActor,
    actors,
    differences,
    rules: report.rules,
    behaviorDiff,
    memory,
    findings,
    summary: {
      actors: actors.length,
      differences: differences.length,
      unexpectedDifferences: unexpected.length,
      rulesFailed: failedRules.length,
      possibleRegressions: possibleRegressions.length,
    },
  };
}
