import { redactText } from '../../security/redactor.js';
import type {
  IncidentBrief,
  InformationSource,
  SilentFailureKind,
  SourcedText,
} from '../../sdk/core/incident-trigger-contracts.js';

/**
 * L'INTERPRÈTE DE LANGAGE NATUREL : une description en français ou en anglais devient une représentation
 * structurée, chaque champ marqué USER_REPORTED. Déterministe (lexique et motifs), sans fournisseur ; une
 * reformulation par l'IA, quand elle existe, s'ajoute en AI_INFERRED sans remplacer ce que la personne a dit.
 * Rien ici n'est une preuve : l'interprète prépare la découverte du périmètre et les catégories à chercher.
 */
const MAX_TEXT = 4000;

const FRENCH_MARKERS =
  /\b(dans|une|des|les|après|lorsque|mais|aucun|aucune|plus|cesse|champ|bouton|erreur|portion|zone)\b/gi;
const ENGLISH_MARKERS = /\b(the|after|when|but|no|button|field|error|stops|screen|page|area|section)\b/gi;

const STOP_WORDS = new Set(
  'dans une des les de la le du un et ou mais après lorsque cette ce ces nos notre notre nous vous ils elles aux au par pour sur avec sans plus que qui quoi dont est sont été être sera ont a il elle on ne pas ni se sa son ses leur leurs tout tous toute toutes certains certaines circonstances inconnues connue connues connaissons exact exactes nécessaires problème application the a an and or but after when of to in on at for with without is are was were be been this that these those our we you they it its no not any some all known unknown exact conditions needed problem application page screen'.split(
    ' ',
  ),
);

const FAILURE_PATTERNS: [RegExp, SilentFailureKind][] = [
  [
    /(erreur|exception|error)\s+(javascript|js|typescript)|javascript error|uncaught|non captur/i,
    'EVENT_HANDLER_EXCEPTION',
  ],
  [/(promesse|promise)/i, 'UNHANDLED_PROMISE_REJECTION'],
  [
    /(ne (r[ée]agit|r[ée]pond) plus|cesse de (r[ée]agir|r[ée]pondre)|stops? (reacting|responding)|no longer (reacts?|responds?)|unresponsive|bloqu[ée]e?s?|blocked|frozen|gel[ée]e?)/i,
    'GLOBAL_ACTION_FAILURE',
  ],
  [
    /(aucune? (validation|requ[êe]te|loading|chargement)|no (validation|request|loading)|ne (d[ée]clenche|part)|not (triggered|sent|emitted))/i,
    'NO_FUNCTIONAL_REACTION_AFTER_ACTION',
  ],
  [/(validation)/i, 'VALIDATION_NOT_EXECUTED'],
  [
    /(aucune? requ[êe]te|no (http )?request|requ[êe]te (http )?(non|pas) (émise|envoy[ée]e)|request (not|never) (sent|emitted))/i,
    'HTTP_REQUEST_NOT_EMITTED',
  ],
  [
    /(requ[êe]te|request)s?\s+(http|r[ée]seau|network)?\s*(ne part|n[e']\s*part|not (sent|emitted)|aucune)/i,
    'HTTP_REQUEST_NOT_EMITTED',
  ],
  [/(soumission|submit|enregistr|save)/i, 'FORM_SUBMISSION_NOT_TRIGGERED'],
  [/(reste|stuck|fig[ée]|frozen|spinner|chargement infini|loading forever)/i, 'UI_STATE_STUCK'],
];

const ENVIRONMENT_PATTERNS =
  /\b(prod(uction)?|recette|staging|uat|test|dev|local|chrome|firefox|edge|safari|mobile|tablette|windows|mac|linux|angular\s*\d+|version\s*\d+[\d.]*)\b/gi;

const DATA_LOSS =
  /(perd(ent|re|u)?|perte|lost|lose|loses|losing)\s+(leurs?\s+|les\s+|their\s+|the\s+)?(donn[ée]es|data|saisie|modifications|changes|work|travail)|(donn[ée]es|data|saisie|modifications|changes|work|travail)\s+(est|sont|is|are|was|were)?\s*(perdu(e|s|es)?|lost)/i;
const RELOAD = /\b(f5|recharg|reload|refresh|rafra[iî]ch)/i;

const AREA_PATTERNS = [
  /(?:dans|sur|in|on)\s+(?:la |le |l'|une |un |the |a |an )?(?:portion|zone|section|partie|page|[ée]cran|module|onglet|screen|area|part|tab)\s+(?:connue?\s+|known\s+)?(?:de\s+|d'|of\s+)?(?:notre|our|l'|la|le|the)?\s*([^.,;:\n]{3,80})/i,
  /(?:portion|zone|section|partie|page|[ée]cran|module|onglet|screen|area|part|tab)\s+(?:«\s*)?["“]?([^.,;:\n"”»]{3,80})/i,
];

const ACTION_PATTERNS = [
  /(?:cliqu\w*|click\w*|appui\w*|press\w*)\s+(?:sur|on)\s+(?:le |la |les |the )?(?:bouton|button)?\s*(?:«\s*)?["“]?([^.,;:\n"”»]{2,60})/i,
  /(?:apr[èe]s|after|when|lorsque)\s+(?:avoir\s+)?(?:cliqu\w*|click\w*|valid\w*|enregistr\w*|saved?|submit\w*|soumis)\s*(?:sur|on)?\s*(?:le |la |the )?(?:bouton|button)?\s*(?:«\s*)?["“]?([^.,;:\n"”»]{2,60})?/i,
];

const SYMPTOM_SPLIT = /(?<=[.!?;])\s+|\n+/;

function detectLanguage(text: string): 'fr' | 'en' {
  const fr = (text.match(FRENCH_MARKERS) ?? []).length;
  const en = (text.match(ENGLISH_MARKERS) ?? []).length;
  return en > fr ? 'en' : 'fr';
}

const sourced = (text: string, source: InformationSource = 'USER_REPORTED'): SourcedText => ({
  text: redactText(text).trim(),
  source,
});

/** Les mots porteurs (sans mots vides, accents conservés, 3 lettres au moins), dédoublonnés, bornés. */
export function keywordsOf(text: string, max = 24): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/[\s'-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([word]) => word);
}

/** Les phrases qui décrivent un symptôme (erreur, blocage, absence de réaction), dans l'ordre du texte. */
function symptomSentences(text: string): string[] {
  return text
    .split(SYMPTOM_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8)
    .filter(
      (sentence) => FAILURE_PATTERNS.some(([pattern]) => pattern.test(sentence)) || DATA_LOSS.test(sentence),
    );
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return value.replace(/\s+/g, ' ');
  }
  return undefined;
}

function conditions(text: string): { known: string[]; unknown: string[] } {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const sentence of text.split(SYMPTOM_SPLIT).map((item) => item.trim())) {
    if (!sentence) continue;
    if (
      /(inconnu|unknown|ne (savons|connaissons) (pas|ni)|don'?t know|not known|certaines circonstances|some circumstances|parfois|sometimes|intermittent)/i.test(
        sentence,
      )
    )
      unknown.push(sentence);
    else if (
      /(nous (savons|connaissons)|we know|connue|known|toujours|always|seulement|only when|uniquement|quand|lorsque|when|after|apr[èe]s)/i.test(
        sentence,
      )
    )
      known.push(sentence);
  }
  return { known, unknown };
}

/** Interprète une description ; `application` et `area` donnés par l'incident (titre, application) complètent le texte. */
export function interpretBrief(
  rawText: string,
  context: { application?: string; title?: string; observed?: string; expected?: string; now?: string } = {},
): IncidentBrief {
  const text = rawText.slice(0, MAX_TEXT);
  const language = detectLanguage(text);
  const area = firstMatch(text, AREA_PATTERNS);
  const action = firstMatch(text, ACTION_PATTERNS);
  const symptoms = symptomSentences(text).map((sentence) => sourced(sentence));
  const { known, unknown } = conditions(text);
  const suspected = new Set<SilentFailureKind>();
  for (const [pattern, kind] of FAILURE_PATTERNS) if (pattern.test(text)) suspected.add(kind);
  const environment = [
    ...new Set((text.match(ENVIRONMENT_PATTERNS) ?? []).map((item) => item.toLowerCase())),
  ].map((item) => sourced(item));
  const observedSentence =
    context.observed ??
    symptoms[0]?.text ??
    text.split(SYMPTOM_SPLIT).find((sentence) => /(erreur|error|bloqu|fail|cesse|stops)/i.test(sentence));
  const expectedSentence =
    context.expected ??
    text
      .split(SYMPTOM_SPLIT)
      .find((sentence) =>
        /(devrait|should|attendu|expected|normalement|normally|r[ée]tablit|restores?)/i.test(sentence),
      );
  const dataLoss = text.split(SYMPTOM_SPLIT).find((sentence) => DATA_LOSS.test(sentence));
  const impact = text
    .split(SYMPTOM_SPLIT)
    .find((sentence) =>
      /(utilisateurs?|users?|clients?|m[ée]tier|business|impact|bloqu[ée]e?s?\s+(toutes|all))/i.test(
        sentence,
      ),
    );
  const keywordSource = [area, action, context.title, text]
    .filter((item): item is string => Boolean(item))
    .join(' ');
  return {
    language,
    rawText: redactText(text),
    ...(context.application ? { application: sourced(context.application) } : {}),
    ...(area ? { functionalArea: sourced(area) } : {}),
    ...(action ? { businessAction: sourced(action) } : {}),
    symptoms,
    ...(expectedSentence ? { expected: sourced(expectedSentence) } : {}),
    ...(observedSentence ? { observed: sourced(observedSentence) } : {}),
    knownConditions: known.map((item) => sourced(item)),
    unknownConditions: unknown.map((item) => sourced(item)),
    ...(impact ? { businessImpact: sourced(impact) } : {}),
    ...(dataLoss
      ? { dataLoss: sourced(`${dataLoss}${RELOAD.test(text) ? ' (après rechargement)' : ''}`) }
      : {}),
    environment,
    suspectedFailures: [...suspected],
    keywords: keywordsOf(keywordSource),
    interpretedAt: context.now ?? new Date().toISOString(),
  };
}

/** Ajoute ce qu'une IA a déduit, sans toucher aux déclarations de la personne (AI_INFERRED, à vérifier). */
export function withInferred(
  brief: IncidentBrief,
  inferred: { functionalArea?: string; businessAction?: string; keywords?: string[]; conditions?: string[] },
): IncidentBrief {
  return {
    ...brief,
    ...(!brief.functionalArea && inferred.functionalArea
      ? { functionalArea: sourced(inferred.functionalArea, 'AI_INFERRED') }
      : {}),
    ...(!brief.businessAction && inferred.businessAction
      ? { businessAction: sourced(inferred.businessAction, 'AI_INFERRED') }
      : {}),
    unknownConditions: [
      ...brief.unknownConditions,
      ...(inferred.conditions ?? []).map((item) => sourced(item, 'AI_INFERRED')),
    ],
    keywords: [
      ...new Set([...brief.keywords, ...(inferred.keywords ?? []).map((word) => word.toLowerCase())]),
    ].slice(0, 32),
  };
}
