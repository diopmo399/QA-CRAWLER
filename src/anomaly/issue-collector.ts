import { SEVERITIES, type Issue, type IssueInput, type Severity } from '../model/issue.js';
import { redactText, redactUrl } from '../security/redactor.js';

/**
 * Collecte les anomalies de tous les observateurs, les masque et fusionne les doublons :
 * la même erreur levée sur 30 pages est une anomalie avec 30 occurrences, pas 30 anomalies.
 */
export class IssueCollector {
  private readonly issues: Issue[] = [];
  private readonly byKey = new Map<string, Issue>();
  private readonly listeners: ((issue: Issue, isNew: boolean) => void)[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  onIssue(listener: (issue: Issue, isNew: boolean) => void): void {
    this.listeners.push(listener);
  }

  add(input: IssueInput & { severity: Severity }): Issue {
    const clean: IssueInput & { severity: Severity } = {
      ...input,
      message: truncate(redactText(input.message), 2000),
      pageUrl: redactUrl(input.pageUrl),
      ...(input.requestUrl !== undefined ? { requestUrl: redactUrl(input.requestUrl) } : {}),
      ...(input.referrerUrl !== undefined ? { referrerUrl: redactUrl(input.referrerUrl) } : {}),
    };
    const key = dedupeKey(clean);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (!existing.pages.includes(clean.pageUrl)) existing.pages.push(clean.pageUrl);
      if (clean.stateId !== undefined && !existing.states.includes(clean.stateId))
        existing.states.push(clean.stateId);
      this.emit(existing, false);
      return existing;
    }

    const issue: Issue = {
      ...clean,
      id: `ISSUE-${String(this.issues.length + 1).padStart(4, '0')}`,
      pages: [clean.pageUrl],
      states: clean.stateId !== undefined ? [clean.stateId] : [],
      timestamp: this.now().toISOString(),
      occurrences: 1,
    };
    this.issues.push(issue);
    this.byKey.set(key, issue);
    this.emit(issue, true);
    return issue;
  }

  all(): Issue[] {
    return [...this.issues];
  }

  forPage(pageUrl: string): Issue[] {
    const redacted = redactUrl(pageUrl);
    return this.issues.filter((issue) => issue.pages.includes(redacted));
  }

  forState(stateId: string): Issue[] {
    return this.issues.filter((issue) => issue.states.includes(stateId));
  }

  /** Rattache les anomalies vues avant que leur état soit connu (par exemple pendant le chargement d'une page). */
  assignState(issueIds: readonly string[], stateId: string, flow: readonly string[]): void {
    for (const issue of this.issues) {
      if (!issueIds.includes(issue.id)) continue;
      if (issue.stateId === undefined) {
        issue.stateId = stateId;
        issue.flow = [...flow];
      }
      if (!issue.states.includes(stateId)) issue.states.push(stateId);
    }
  }

  countBySeverity(): Record<Severity, number> {
    const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<
      Severity,
      number
    >;
    for (const issue of this.issues) counts[issue.severity] += 1;
    return counts;
  }

  private emit(issue: Issue, isNew: boolean): void {
    for (const listener of this.listeners) listener(issue, isNew);
  }
}

/**
 * Deux anomalies sont « les mêmes » quand elles ont la même nature et la même
 * cible, quelle que soit la page où elles ont été vues. Les nombres des messages
 * (numéros de ligne, id, durées) sont ignorés pour fusionner aussi les erreurs presque identiques.
 */
/** La clé d'une anomalie : la même d'une occurrence à l'autre, et d'un run à l'autre. */
export function dedupeKey(issue: IssueInput): string {
  const message = issue.message.replace(/\d+/g, '#').slice(0, 300);
  return [issue.type, issue.method ?? '', issue.requestUrl ?? '', issue.status ?? '', message].join('|');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
