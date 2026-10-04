import { fieldIdentityOfEvent, matchFieldIdentity, type FieldIdentity } from './field-identity.js';
import type { RawRecordedEvent, SemanticRecordedAction } from './model.js';

/**
 * FIELD MERGE VALIDATOR : une action FILL qui porte plusieurs saisies humaines les a-t-elle
 * fusionnées À TORT ? (deux instances DOM, deux libellés, deux profils, deux contextes ; une clé
 * de donnée générique pour des champs distincts). Signalé, jamais corrigé en silence ; un ancien
 * enregistrement (sans instance DOM) n'est que POSSIBLY_INVALID_FIELD_MERGE.
 */
export interface FieldMergeIssue {
  type: 'INVALID_FIELD_MERGE' | 'POSSIBLY_INVALID_FIELD_MERGE' | 'GENERIC_TEST_DATA_KEY';
  actionId: string;
  rawEventIds: string[];
  reasons: string[];
}

export function validateFieldMerges(
  actions: readonly SemanticRecordedAction[],
  rawEvents: readonly RawRecordedEvent[],
): FieldMergeIssue[] {
  const byId = new Map(rawEvents.map((event) => [event.id, event]));
  const issues: FieldMergeIssue[] = [];
  const typingOf = (action: SemanticRecordedAction): { event: RawRecordedEvent; identity: FieldIdentity }[] =>
    action.rawEventIds
      .map((id) => byId.get(id))
      .filter((event): event is RawRecordedEvent => event?.type === 'input' || event?.type === 'change')
      .flatMap((event) => {
        const identity = fieldIdentityOfEvent(event);
        return identity ? [{ event, identity }] : [];
      });
  const live = actions.filter((action) => action.type === 'FILL' && !action.dropped);
  for (const action of live) {
    const typing = typingOf(action);
    if (typing.length < 2) continue;
    const reasons = new Set<string>();
    let invalid = false;
    let ambiguous = false;
    for (const [index, entry] of typing.entries())
      for (const other of typing.slice(index + 1)) {
        const match = matchFieldIdentity(entry.identity, other.identity);
        if (match.verdict === 'DIFFERENT_FIELD') {
          invalid = true;
          for (const reason of match.confidence.reasons)
            reasons.add(`${entry.event.id}/${other.event.id}: ${reason}`);
        } else if (match.verdict === 'AMBIGUOUS_FIELD') {
          ambiguous = true;
          reasons.add(
            `${entry.event.id}/${other.event.id}: ${match.confidence.reasons[0] ?? 'ambiguous field identity'}`,
          );
        }
      }
    // Des valeurs différentes, un CSS générique, une clé « value » : plusieurs saisies effondrées ?
    const digests = new Set(typing.map(({ event }) => event.value?.digest).filter(Boolean));
    const generic =
      action.target?.quality === 'FRAGILE' ||
      typing.some(({ identity }) => identity.locatorUniqueness === 'NON_UNIQUE');
    if (!invalid && ambiguous && generic && (digests.size > 1 || action.value?.testData === 'value'))
      reasons.add('several human inputs on a generic locator (no DOM instance to prove the same field)');
    if (invalid || (ambiguous && generic))
      issues.push({
        type: invalid ? 'INVALID_FIELD_MERGE' : 'POSSIBLY_INVALID_FIELD_MERGE',
        actionId: action.id,
        rawEventIds: typing.map(({ event }) => event.id),
        reasons: [...reasons],
      });
  }
  // Une clé de donnée générique partagée par des champs distincts.
  const byKey = new Map<string, { action: SemanticRecordedAction; identity?: FieldIdentity }[]>();
  for (const action of live) {
    const key = action.value?.testData;
    if (!key) continue;
    const identity = typingOf(action).at(-1)?.identity;
    byKey.set(key, [...(byKey.get(key) ?? []), { action, ...(identity ? { identity } : {}) }]);
  }
  for (const [key, entries] of byKey)
    for (const [index, entry] of entries.entries())
      for (const other of entries.slice(index + 1))
        if (
          entry.identity &&
          other.identity &&
          matchFieldIdentity(entry.identity, other.identity).verdict === 'DIFFERENT_FIELD'
        )
          issues.push({
            type: 'GENERIC_TEST_DATA_KEY',
            actionId: other.action.id,
            rawEventIds: [...entry.action.rawEventIds, ...other.action.rawEventIds],
            reasons: [
              `testData.${key} is used by two different fields (${entry.action.id}, ${other.action.id})`,
            ],
          });
  return issues;
}
