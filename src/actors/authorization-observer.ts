import type { BrowserContextOptions, Page } from 'playwright';
import { IssueCollector } from '../anomaly/issue-collector.js';
import { AuthError, createAuthenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import type { ActorConfig, ScenarioConfig } from '../config/config.js';
import type { Issue } from '../model/issue.js';
import { KeywordMatcher } from '../policies/keywords.js';
import { pathPatternToRegex } from '../policies/navigation-policy.js';
import { SafetyPolicy } from '../policies/safety-policy.js';
import { StateDetector } from '../observation/state-detector.js';
import { UIObserver } from '../observation/ui-observer.js';
import { redactUrl } from '../security/redactor.js';

/**
 * ALLOWED : l'écran s'est ouvert. DENIED : HTTP 401/403, renvoi vers la page
 * de connexion, ou message de refus. NOT_FOUND : HTTP 404. ERROR : HTTP 5xx
 * ou la page ne s'est pas chargée.
 */
export type Access = 'ALLOWED' | 'DENIED' | 'NOT_FOUND' | 'ERROR';

/** Un écran trouvé par l'exploration, à ouvrir avec chaque acteur. */
export interface AccessTarget {
  stateId: string;
  label: string;
  url: string;
}

export interface AccessObservation {
  actor: string;
  stateId: string;
  label: string;
  url: string;
  access: Access;
  status?: number;
  /** Écran vu par l'acteur, quand l'accès est permis. */
  observedLabel?: string;
  /** Il a vu le même écran que l'acteur principal. */
  sameScreen?: boolean;
  reason?: string;
}

/** Un écran que les acteurs n'atteignent pas de la même façon. */
export interface AccessDifference {
  stateId: string;
  label: string;
  url: string;
  access: Record<string, Access>;
  message: string;
}

export interface AuthorizationRuleResult {
  actor: string;
  path: string;
  expect: 'allowed' | 'denied';
  /** PASS : chaque écran concerné est comme attendu ; FAIL : l'un ne l'est pas ; UNKNOWN : aucun écran concerné. */
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  checked: number;
  violations: string[];
}

export interface AuthorizationReport {
  primaryActor: string;
  actors: string[];
  observations: AccessObservation[];
  differences: AccessDifference[];
  rules: AuthorizationRuleResult[];
  /** Acteurs qui n'ont pas pu se connecter (aucun secret dans le message). */
  errors: { actor: string; message: string }[];
}

const DENIED_TEXTS = [
  'access denied',
  'forbidden',
  'not authorized',
  'not authorised',
  'unauthorized',
  'permission denied',
  'acces refuse',
  'non autorise',
  'interdit',
  'vous n avez pas les droits',
];

/**
 * OBSERVATION DES AUTORISATIONS : ouvre les écrans trouvés par l'exploration
 * avec chaque autre acteur (simples chargements de page — aucun clic, aucun
 * formulaire, rien d'envoyé), note ce que chacun atteint, les différences avec
 * l'acteur principal, et vérifie les règles de la mission (reader → /admin/*
 * refusé). Une différence d'accès est une observation ; seule une règle la
 * transforme en PASS ou FAIL.
 */
export class AuthorizationObserver {
  private readonly safety: SafetyPolicy;
  private readonly detector: StateDetector;
  private readonly observer = new UIObserver();
  private readonly denied: KeywordMatcher;

  constructor(
    private readonly config: ScenarioConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.safety = new SafetyPolicy(config.safety);
    this.detector = new StateDetector(
      config.exploration.queryParams.mode,
      config.exploration.queryParams.ignored,
    );
    this.denied = new KeywordMatcher([...DENIED_TEXTS, ...config.authorization.deniedTexts]);
  }

  async observe(targets: readonly AccessTarget[]): Promise<{ report: AuthorizationReport; issues: Issue[] }> {
    const { authorization, actors } = this.config;
    const primary = authorization.primaryActor;
    const screens = this.targetsOf(targets);
    const observations: AccessObservation[] = screens.map((target) => ({
      actor: primary,
      ...target,
      access: 'ALLOWED',
      observedLabel: target.label,
      sameScreen: true,
    }));
    const errors: AuthorizationReport['errors'] = [];
    for (const actor of actors) {
      try {
        observations.push(...(await this.observeActor(actor, screens)));
      } catch (error) {
        errors.push({
          actor: actor.name,
          message: error instanceof AuthError ? error.message : `observation failed: ${firstLine(error)}`,
        });
      }
    }
    const differences = this.differencesOf(screens, observations);
    const collector = new IssueCollector();
    const rules = authorization.rules.map((rule) => {
      const { result, violating } = evaluateRule(rule, observations);
      for (const observation of violating)
        collector.add({
          type: 'AUTHORIZATION',
          severity: 'ERROR',
          message: `Authorization rule failed: ${rule.actor} must be ${rule.expect} on ${rule.path}, but ${violationOf(observation)}`,
          pageUrl: observation.url,
          stateId: observation.stateId,
        });
      return result;
    });
    for (const error of errors)
      collector.add({
        type: 'AUTHORIZATION',
        severity: 'WARNING',
        message: `Actor ${error.actor} not observed: ${error.message}`,
        pageUrl: redactUrl(this.config.target.baseUrl),
      });
    return {
      report: {
        primaryActor: primary,
        actors: [primary, ...actors.map((actor) => actor.name)],
        observations,
        differences,
        rules,
        errors,
      },
      issues: collector.all(),
    };
  }

  /** Un écran par URL, dans le périmètre de la mission, dans la limite fixée. */
  private targetsOf(targets: readonly AccessTarget[]): AccessTarget[] {
    const seen = new Set<string>();
    const kept: AccessTarget[] = [];
    for (const target of targets) {
      let url: URL;
      try {
        url = new URL(target.url);
      } catch {
        continue;
      }
      url.hash = '';
      if (seen.has(url.toString()) || !this.safety.navigation.evaluate(url).allowed) continue;
      seen.add(url.toString());
      kept.push({ ...target, url: url.toString() });
      if (kept.length >= this.config.authorization.maxTargets) break;
    }
    return kept;
  }

  private async observeActor(
    actor: ActorConfig,
    targets: readonly AccessTarget[],
  ): Promise<AccessObservation[]> {
    const browser = new BrowserManager(this.config.browser);
    const startUrl = new URL(this.config.target.startAt, this.config.target.baseUrl).toString();
    const authenticator = createAuthenticator(actor.auth, this.config.target.baseUrl, this.env, startUrl);
    try {
      await browser.start(this.contextOptions(actor));
      const page = await browser.newPage();
      await authenticator.login(page);
      const observations: AccessObservation[] = [];
      for (const target of targets) observations.push(await this.open(page, actor, target));
      return observations;
    } finally {
      await browser.close();
    }
  }

  /** auth.type http : le navigateur répond au défi du serveur avec les identifiants de l'acteur. */
  private contextOptions(actor: ActorConfig): BrowserContextOptions {
    if (actor.auth.type !== 'http') return {};
    const username = this.env[actor.auth.usernameEnv];
    const password = this.env[actor.auth.passwordEnv];
    if (!username || !password)
      throw new AuthError(
        `Missing environment variable(s) for authentication: ${[actor.auth.usernameEnv, actor.auth.passwordEnv].join(', ')}`,
      );
    return {
      httpCredentials: {
        username,
        password,
        ...(actor.auth.origin ? { origin: actor.auth.origin } : {}),
      },
    };
  }

  private async open(page: Page, actor: ActorConfig, target: AccessTarget): Promise<AccessObservation> {
    const base = {
      actor: actor.name,
      stateId: target.stateId,
      label: target.label,
      url: redactUrl(target.url),
    };
    const { exploration } = this.config;
    let status: number | undefined;
    try {
      const response = await page.goto(target.url, {
        waitUntil: exploration.waitUntil,
        timeout: exploration.navigationTimeoutMs,
      });
      status = response?.status();
      if (exploration.settleTimeMs > 0) await page.waitForTimeout(exploration.settleTimeMs);
    } catch (error) {
      return { ...base, access: 'ERROR', reason: firstLine(error) };
    }
    const withStatus = status !== undefined ? { status } : {};
    if (status === 401 || status === 403)
      return { ...base, ...withStatus, access: 'DENIED', reason: `HTTP ${status}` };
    if (status === 404) return { ...base, ...withStatus, access: 'NOT_FOUND', reason: 'HTTP 404' };
    if (status !== undefined && status >= 500)
      return { ...base, ...withStatus, access: 'ERROR', reason: `HTTP ${status}` };
    if (this.onLoginPage(actor, page.url()))
      return { ...base, ...withStatus, access: 'DENIED', reason: 'sent to the login page' };
    const snapshot = await this.observer.observe(page).catch(() => undefined);
    if (!snapshot) return { ...base, ...withStatus, access: 'ERROR', reason: 'page not observable' };
    const refusal = this.denied.match([snapshot.title, ...snapshot.headings, ...snapshot.dialogs].join(' '));
    if (refusal) return { ...base, ...withStatus, access: 'DENIED', reason: `"${refusal}" shown` };
    const state = this.detector.detect(snapshot);
    // Envoyé ailleurs (souvent l'accueil) au lieu de l'écran demandé : un refus.
    if (pathOf(page.url()) !== pathOf(target.url) && state.label !== target.label)
      return {
        ...base,
        ...withStatus,
        access: 'DENIED',
        observedLabel: state.label,
        reason: `redirected to ${pathOf(page.url()) ?? page.url()}`,
      };
    return {
      ...base,
      ...withStatus,
      access: 'ALLOWED',
      observedLabel: state.label,
      sameScreen: state.label === target.label,
    };
  }

  private onLoginPage(actor: ActorConfig, url: string): boolean {
    if (actor.auth.type !== 'form') return false;
    try {
      return new URL(url).pathname === new URL(actor.auth.loginUrl, this.config.target.baseUrl).pathname;
    } catch {
      return false;
    }
  }

  private differencesOf(
    targets: readonly AccessTarget[],
    observations: readonly AccessObservation[],
  ): AccessDifference[] {
    const differences: AccessDifference[] = [];
    for (const target of targets) {
      const access: Record<string, Access> = {};
      for (const observation of observations)
        if (observation.stateId === target.stateId) access[observation.actor] = observation.access;
      const values = new Set(Object.values(access));
      if (values.size <= 1) continue;
      differences.push({
        stateId: target.stateId,
        label: target.label,
        url: redactUrl(target.url),
        access,
        message: `ACCESS DIFFERENCE on ${target.label}: ${Object.entries(access)
          .map(([actor, value]) => `${actor} ${value}`)
          .join(', ')}`,
      });
    }
    return differences;
  }
}

function evaluateRule(
  rule: ScenarioConfig['authorization']['rules'][number],
  observations: readonly AccessObservation[],
): { result: AuthorizationRuleResult; violating: AccessObservation[] } {
  const pattern = pathPatternToRegex(rule.path);
  const matching = observations.filter((observation) => {
    if (observation.actor !== rule.actor) return false;
    try {
      return pattern.test(new URL(observation.url).pathname);
    } catch {
      return false;
    }
  });
  // Une erreur ne dit rien de la permission : elle n'est comptée dans aucun sens.
  const judged = matching.filter(
    (observation) => observation.access === 'ALLOWED' || observation.access === 'DENIED',
  );
  const violating = judged.filter(
    (observation) => (rule.expect === 'denied') !== (observation.access === 'DENIED'),
  );
  return {
    result: {
      actor: rule.actor,
      path: rule.path,
      expect: rule.expect,
      status: judged.length === 0 ? 'UNKNOWN' : violating.length > 0 ? 'FAIL' : 'PASS',
      checked: judged.length,
      violations: violating.map(violationOf),
    },
    violating,
  };
}

function violationOf(observation: AccessObservation): string {
  return `${observation.url} was ${observation.access}${observation.reason ? ` (${observation.reason})` : ''}`;
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? message).trim();
}
