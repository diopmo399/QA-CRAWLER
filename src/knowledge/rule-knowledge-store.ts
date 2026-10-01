import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../memory/atomic-write.js';
import type { ApplicationRule, RuleCoverageStatus, RuleStatus } from '../static-analysis/rules/rule-model.js';
import { sha256 } from '../static-analysis/source-set.js';

/** Ce qu'un run précédent a appris d'une règle, par signature (jamais une valeur saisie). */
export interface RememberedRule {
  signature: string;
  name: string;
  category: string;
  status: RuleStatus;
  coverage: RuleCoverageStatus;
  confirmations: number;
  contradictions: number;
  lastVerifiedAt?: string;
  /** La version de l'application qui a donné ce statut. */
  version?: string;
  commit?: string;
  environment?: string;
  sourceHash?: string;
}

export interface RuleIdentity {
  application: string;
  environment?: string;
  version?: string;
  commit?: string;
  sourceHash?: string;
}

/**
 * RULE KNOWLEDGE : les règles et leurs vérifications, gardées d'un run à l'autre dans la
 * base de connaissance (knowledge/rules/, un JSON par application et environnement).
 * L'HISTORIQUE N'EST JAMAIS UNE PREUVE : une règle confirmée sur une autre version reste
 * STATIC_DISCOVERED tant que le runtime courant ne l'a pas revue ; l'historique sert
 * seulement à l'afficher (« confirmée en 1.4.0 ») et à prioriser.
 */
export class RuleKnowledgeStore {
  private remembered = new Map<string, RememberedRule>();

  constructor(
    private readonly directory: string,
    private readonly identity: RuleIdentity,
  ) {}

  private file(): string {
    const key = sha256(`${this.identity.application}\n${this.identity.environment ?? ''}`).slice(0, 24);
    return path.join(this.directory, `rules-${key}.json`);
  }

  async load(): Promise<void> {
    const text = await readFile(this.file(), 'utf8').catch(() => undefined);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { rules?: RememberedRule[] };
      this.remembered = new Map((parsed.rules ?? []).map((rule) => [rule.signature, rule]));
    } catch {
      this.remembered = new Map();
    }
  }

  /** Ce que l'historique sait d'une règle ; `sameVersion` : appris sur la version courante. */
  recall(signature: string): (RememberedRule & { sameVersion: boolean }) | undefined {
    const rule = this.remembered.get(signature);
    if (!rule) return undefined;
    const sameVersion =
      (rule.commit ?? rule.version ?? rule.sourceHash) !== undefined &&
      (rule.commit ?? rule.version ?? rule.sourceHash) ===
        (this.identity.commit ?? this.identity.version ?? this.identity.sourceHash);
    return { ...rule, sameVersion };
  }

  /** Les statuts du run courant remplacent l'historique ; les règles non revues sont gardées. */
  async save(rules: readonly ApplicationRule[]): Promise<void> {
    for (const rule of rules) {
      const previous = this.remembered.get(rule.signature);
      const verified = rule.status === 'RUNTIME_CONFIRMED' || rule.status === 'RUNTIME_CONTRADICTED';
      this.remembered.set(rule.signature, {
        signature: rule.signature,
        name: rule.name,
        category: rule.category,
        status: verified || !previous ? rule.status : previous.status,
        coverage: verified || !previous ? (rule.coverage ?? 'NOT_VERIFIED') : previous.coverage,
        confirmations: (previous?.confirmations ?? 0) + (rule.status === 'RUNTIME_CONFIRMED' ? 1 : 0),
        contradictions: (previous?.contradictions ?? 0) + (rule.status === 'RUNTIME_CONTRADICTED' ? 1 : 0),
        ...(verified
          ? { lastVerifiedAt: new Date().toISOString() }
          : previous?.lastVerifiedAt
            ? { lastVerifiedAt: previous.lastVerifiedAt }
            : {}),
        ...(verified
          ? {
              ...(this.identity.version ? { version: this.identity.version } : {}),
              ...(this.identity.commit ? { commit: this.identity.commit } : {}),
              ...(this.identity.environment ? { environment: this.identity.environment } : {}),
              ...(this.identity.sourceHash ? { sourceHash: this.identity.sourceHash } : {}),
            }
          : {
              ...(previous?.version ? { version: previous.version } : {}),
              ...(previous?.commit ? { commit: previous.commit } : {}),
              ...(previous?.environment ? { environment: previous.environment } : {}),
              ...(previous?.sourceHash ? { sourceHash: previous.sourceHash } : {}),
            }),
      });
    }
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(
      this.file(),
      `${JSON.stringify({ application: this.identity.application, rules: [...this.remembered.values()].slice(-2000) }, null, 2)}\n`,
    );
  }
}
