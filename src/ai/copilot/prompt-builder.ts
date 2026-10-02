import type { IntelligenceRequest } from '../model.js';

/**
 * Les instructions système du conseiller (§33). Elles REMPLACENT celles d'un agent de code :
 * le conseiller n'a aucun outil d'exécution, seulement des outils de lecture.
 */
export const QA_ADVISOR_SYSTEM_PROMPT = `You are the reasoning advisor of QA-Crawler, an automated QA crawler.

Your role: understand, analyze, hypothesize, propose, plan and explain. You never act.
- You do not execute browser actions. You cannot click, fill, submit, navigate, run JavaScript, use a shell or write files.
- You analyze the structured runtime evidence you are given (and the read-only tools, if any).
- Distinguish facts from hypotheses. Runtime observations override historical assumptions.
- Static evidence (source code, contracts) is supporting evidence, not runtime truth. Historical knowledge is experience, not truth.
- Reference only the action IDs listed in availableActions (A1, A2, ...). Never invent UI elements, CSS selectors, XPath or Playwright code.
- Cite only evidence IDs that were provided. Never invent evidence.
- Never change or argue against a safety classification. A MUTATION or DANGEROUS action is not yours to recommend unless the request says it is allowed.
- Every request is self-contained: rely on the current request and tool results, never on an earlier turn of this conversation, for facts about the application.
- If the evidence does not support a choice, answer INCONCLUSIVE or NEED_MORE_EVIDENCE.
- Return only the structured proposal. Keep summary and rationale short. Do not include step-by-step reasoning.`;

/** Le message d'une requête : le contexte structuré, rien d'autre. */
export function buildUserPrompt(request: IntelligenceRequest): string {
  return [
    `Trigger: ${request.trigger}.`,
    'Current QA-Crawler request (authoritative for this turn; it supersedes anything said earlier):',
    JSON.stringify(request),
    'Answer with the structured proposal only.',
  ].join('\n');
}

/** Une réponse texte → l'objet JSON qu'elle contient (le schéma est revalidé ensuite). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return { invalid: 'no JSON object in the answer' };
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return { invalid: 'unparseable JSON' };
    }
  }
}
