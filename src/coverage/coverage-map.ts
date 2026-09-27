import { actionSignature } from '../knowledge/signatures.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import type { DetectedPattern, UiPattern } from '../patterns/ui-pattern.js';

/** Où en est un élément de l'application : vu, exécuté, bloqué, ou impossible à atteindre. */
export const COVERAGE_STATUSES = ['DISCOVERED', 'EXECUTED', 'BLOCKED', 'UNREACHABLE'] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export type CoverageCounts = Record<CoverageStatus, number>;

/** Couverture d'une zone de l'application (premier segment de route : /users, /parking…). */
export interface AreaCoverage {
  area: string;
  actions: CoverageCounts;
  /** 0..1 : actions exécutées (ou bloquées : on ne peut pas faire plus) sur actions découvertes. */
  ratio: number;
}

export interface CoverageMap {
  states: CoverageCounts;
  actions: CoverageCounts;
  transitions: { executed: number; failed: number; blocked: number };
  forms: CoverageCounts;
  patterns: Partial<Record<UiPattern, { screens: number; explored: number }>>;
  areas: AreaCoverage[];
}

const zero = (): CoverageCounts => ({ DISCOVERED: 0, EXECUTED: 0, BLOCKED: 0, UNREACHABLE: 0 });

/**
 * La couverture fonctionnelle, tenue à jour pendant le run : états, actions,
 * transitions, formulaires et motifs, avec leur statut (DISCOVERED, EXECUTED,
 * BLOCKED, UNREACHABLE), et par zone de l'application. Le moteur de décision s'en sert
 * pour préférer, à mission égale, ce qui est peu couvert (Parking 20 % avant Users 90 %).
 */
export class CoverageTracker {
  private readonly states = new Map<
    string,
    { route: string; status: CoverageStatus; patterns: UiPattern[] }
  >();
  /** Clé : `stateId::actionId`. */
  private readonly actions = new Map<string, { area: string; status: CoverageStatus; signature: string }>();
  private readonly forms = new Map<string, CoverageStatus>();
  private transitions = { executed: 0, failed: 0, blocked: 0 };
  /** Exécutions de chaque signature d'action pendant ce run. */
  private readonly executedSignatures = new Map<string, number>();

  observeState(context: PageContext, patterns: readonly DetectedPattern[]): void {
    const existing = this.states.get(context.stateId);
    const types = patterns.map((pattern) => pattern.type);
    if (!existing)
      this.states.set(context.stateId, { route: context.route, status: 'DISCOVERED', patterns: types });
    else {
      existing.patterns = [...new Set([...existing.patterns, ...types])];
      if (existing.status === 'UNREACHABLE') existing.status = 'DISCOVERED';
    }
    const area = areaOf(context.route);
    for (const action of context.actions) {
      const key = `${context.stateId}::${action.id}`;
      if (!this.actions.has(key))
        this.actions.set(key, { area, status: 'DISCOVERED', signature: actionSignature(action) });
    }
    for (const form of context.forms) {
      const key = `${context.stateId}::${form.index}`;
      if (!this.forms.has(key)) this.forms.set(key, 'DISCOVERED');
    }
  }

  /** L'état a été quitté après y avoir fait au moins une action : exploré. */
  stateExecuted(stateId: string): void {
    const state = this.states.get(stateId);
    if (state) state.status = 'EXECUTED';
  }

  stateUnreachable(stateId: string): void {
    const state = this.states.get(stateId);
    if (state && state.status === 'DISCOVERED') state.status = 'UNREACHABLE';
  }

  actionExecuted(stateId: string, action: DiscoveredAction, success: boolean): void {
    const key = `${stateId}::${action.id}`;
    const entry = this.actions.get(key) ?? {
      area: 'unknown',
      status: 'DISCOVERED',
      signature: actionSignature(action),
    };
    entry.status = 'EXECUTED';
    this.actions.set(key, entry);
    this.executedSignatures.set(entry.signature, (this.executedSignatures.get(entry.signature) ?? 0) + 1);
    if (success) this.transitions.executed += 1;
    else this.transitions.failed += 1;
    this.stateExecuted(stateId);
  }

  actionBlocked(stateId: string, action: DiscoveredAction): void {
    const key = `${stateId}::${action.id}`;
    const entry = this.actions.get(key) ?? {
      area: 'unknown',
      status: 'DISCOVERED',
      signature: actionSignature(action),
    };
    if (entry.status !== 'EXECUTED') entry.status = 'BLOCKED';
    this.actions.set(key, entry);
    this.transitions.blocked += 1;
  }

  formExercised(stateId: string, formIndex: number): void {
    this.forms.set(`${stateId}::${formIndex}`, 'EXECUTED');
  }

  /** Nombre d'exécutions d'une signature d'action pendant ce run. */
  timesExecuted(signature: string): number {
    return this.executedSignatures.get(signature) ?? 0;
  }

  /** Motifs déjà vus pendant ce run. */
  seenPatterns(): Set<UiPattern> {
    return new Set([...this.states.values()].flatMap((state) => state.patterns));
  }

  /** 0..1 : couverture d'une zone (1 si inconnue : rien à gagner à y aller pour la couverture). */
  areaRatio(area: string): number {
    return this.areas().find((entry) => entry.area === area)?.ratio ?? 1;
  }

  areas(): AreaCoverage[] {
    const byArea = new Map<string, CoverageCounts>();
    for (const action of this.actions.values()) {
      const counts = byArea.get(action.area) ?? zero();
      counts[action.status] += 1;
      byArea.set(action.area, counts);
    }
    return [...byArea.entries()]
      .map(([area, actions]) => {
        const total = actions.DISCOVERED + actions.EXECUTED + actions.BLOCKED + actions.UNREACHABLE;
        return {
          area,
          actions,
          ratio: total === 0 ? 1 : Math.round(((actions.EXECUTED + actions.BLOCKED) / total) * 100) / 100,
        };
      })
      .sort((a, b) => a.area.localeCompare(b.area));
  }

  map(): CoverageMap {
    const states = zero();
    const patterns: CoverageMap['patterns'] = {};
    for (const state of this.states.values()) {
      states[state.status] += 1;
      for (const pattern of state.patterns) {
        const entry = (patterns[pattern] ??= { screens: 0, explored: 0 });
        entry.screens += 1;
        if (state.status === 'EXECUTED') entry.explored += 1;
      }
    }
    const actions = zero();
    for (const action of this.actions.values()) actions[action.status] += 1;
    const forms = zero();
    for (const status of this.forms.values()) forms[status] += 1;
    return { states, actions, transitions: { ...this.transitions }, forms, patterns, areas: this.areas() };
  }
}

/** « /users/:id/edit » → « users » ; la racine → « / ». */
export function areaOf(route: string): string {
  const path = route.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0] ?? '';
  const first = path.split('/').find((segment) => segment && !segment.startsWith(':'));
  return first ?? '/';
}
