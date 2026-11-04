/**
 * UNE ATTENTE (Wait) : une condition que le moteur attend avant de continuer, jusqu'à un délai. Elle se
 * compile en une étape `expect` ordinaire du flow (rien de nouveau dans l'exécuteur) :
 *
 *   VISIBLE  → expect.visible  (un élément : sélecteur CSS ou texte visible)
 *   HIDDEN   → expect.hidden   (l'élément disparaît ou est caché)
 *   TEXT     → expect.text     (un texte métier visible sur la page)
 *   URL      → expect.url      (l'adresse contient ce texte)
 *   RESPONSE → expect.response (une réponse HTTP vue depuis le début du flow ; si la requête est partie et
 *              n'a pas encore répondu, le moteur l'attend jusqu'au délai)
 *
 * Le délai est le `timeoutMs` de l'étape ; « continuer avec un avertissement » est `optional: true`
 * (l'échec est un WARNING et le flow continue). Les textes et adresses peuvent citer une donnée produite
 * plus haut (`${testData:clé}`) : le moteur la lit dans le contexte du run, sans la régénérer. Un sélecteur
 * CSS ne cite jamais une donnée (le moteur le refuse).
 *
 * Ce que le moteur ne fait pas n'est pas proposé comme réglable : l'attente « cliquable », la durée fixe,
 * l'intervalle de vérification (Playwright interroge la page lui-même).
 */

export const WAIT_TYPES = ['VISIBLE', 'HIDDEN', 'TEXT', 'URL', 'RESPONSE'] as const;
export type WaitType = (typeof WAIT_TYPES)[number];
export const WAIT_STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
export type WaitStatus = number | (typeof WAIT_STATUS_CLASSES)[number];

export interface WaitSpec {
  type: WaitType;
  /** VISIBLE / HIDDEN : un sélecteur CSS… */
  selector?: string;
  /** …ou un texte visible (VISIBLE / HIDDEN) ; TEXT : le texte attendu. */
  text?: string;
  /** URL : l'adresse contient ce texte ; RESPONSE : l'adresse de la requête (sous-chaîne, ou chemin avec * et **). */
  url?: string;
  /** RESPONSE : la méthode (facultative) et le statut attendu (2xx par défaut). */
  method?: string;
  status?: WaitStatus;
  /** Le délai maximal, en secondes. */
  timeoutS: number;
  /** Au délai : arrêter le scénario (FAIL) ou continuer avec un avertissement (WARN). */
  onTimeout: 'FAIL' | 'WARN';
}

export const WAIT_TIMEOUT = { min: 1, max: 300, default: 30 } as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const REFERENCE = /\$\{testData:([A-Za-z0-9_.-]+)\}/g;
const TEXT_MAX = 300;

/** Une attente par défaut (le type choisi, les autres réglages à compléter). */
export function defaultWait(type: WaitType = 'VISIBLE'): WaitSpec {
  return { type, timeoutS: WAIT_TIMEOUT.default, onTimeout: 'FAIL' };
}

const clean = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  return text || undefined;
};

/** Une attente reçue (JSON) ramenée à sa forme : les champs inconnus ou hors type sont ignorés. */
export function sanitizeWait(raw: unknown): WaitSpec {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const type = WAIT_TYPES.find((candidate) => candidate === value.type) ?? 'VISIBLE';
  const seconds =
    typeof value.timeoutS === 'number' && Number.isFinite(value.timeoutS) ? value.timeoutS : NaN;
  const timeoutS = Number.isNaN(seconds)
    ? WAIT_TIMEOUT.default
    : Math.round(Math.min(Math.max(seconds, 0), 10_000));
  const spec: WaitSpec = { type, timeoutS, onTimeout: value.onTimeout === 'WARN' ? 'WARN' : 'FAIL' };
  const selector = clean(value.selector);
  const text = clean(value.text);
  const url = clean(value.url);
  if ((type === 'VISIBLE' || type === 'HIDDEN') && selector) spec.selector = selector;
  if ((type === 'VISIBLE' || type === 'HIDDEN' || type === 'TEXT') && text) spec.text = text;
  if ((type === 'URL' || type === 'RESPONSE') && url) spec.url = url;
  if (type === 'RESPONSE') {
    const method = clean(value.method)?.toUpperCase();
    if (method) spec.method = method;
    if (typeof value.status === 'number' && Number.isInteger(value.status)) spec.status = value.status;
    else if (WAIT_STATUS_CLASSES.some((status) => status === value.status))
      spec.status = value.status as WaitStatus;
  }
  return spec;
}

/** Ce qui empêche l'attente de s'exécuter, en mots (vide : elle est complète). */
export function waitProblems(spec: WaitSpec): string[] {
  const problems: string[] = [];
  if (spec.timeoutS < WAIT_TIMEOUT.min || spec.timeoutS > WAIT_TIMEOUT.max)
    problems.push(
      `le délai est compris entre ${String(WAIT_TIMEOUT.min)} et ${String(WAIT_TIMEOUT.max)} secondes`,
    );
  switch (spec.type) {
    case 'VISIBLE':
    case 'HIDDEN':
      if (!spec.selector && !spec.text) problems.push('indiquez un sélecteur CSS ou un texte visible');
      if (spec.selector && spec.text) problems.push('un sélecteur CSS ou un texte, pas les deux');
      if (spec.selector?.includes('${testData:'))
        problems.push('un sélecteur CSS ne cite pas de donnée : utilisez un texte visible');
      break;
    case 'TEXT':
      if (!spec.text) problems.push('indiquez le texte attendu');
      break;
    case 'URL':
      if (!spec.url) problems.push('indiquez le texte que l’adresse doit contenir');
      break;
    case 'RESPONSE':
      if (!spec.url) problems.push('indiquez l’adresse de la requête');
      if (spec.method && !METHODS.includes(spec.method))
        problems.push(`méthode inconnue : ${spec.method} (${METHODS.join(', ')})`);
      if (typeof spec.status === 'number' && (spec.status < 100 || spec.status > 599))
        problems.push('un statut HTTP est compris entre 100 et 599');
      break;
  }
  return problems;
}

/** Les données que l'attente cite (`${testData:clé}`) : elles doivent exister avant elle. */
export function waitReferences(spec: WaitSpec): string[] {
  const keys: string[] = [];
  for (const text of [spec.text, spec.url])
    for (const match of (text ?? '').matchAll(REFERENCE))
      if (match[1] && !keys.includes(match[1])) keys.push(match[1]);
  return keys;
}

/** L'attente dans le format exécutable du moteur : une étape `expect` (YAML brut, avant validation). */
export function waitStep(spec: WaitSpec, name?: string): Record<string, unknown> {
  const target = spec.selector ? { css: spec.selector } : { text: spec.text ?? '' };
  const expect: Record<string, unknown> =
    spec.type === 'VISIBLE'
      ? { visible: target }
      : spec.type === 'HIDDEN'
        ? { hidden: target }
        : spec.type === 'TEXT'
          ? { text: spec.text ?? '' }
          : spec.type === 'URL'
            ? { url: spec.url ?? '' }
            : {
                response: {
                  ...(spec.method ? { method: spec.method } : {}),
                  url: spec.url ?? '',
                  status: spec.status ?? '2xx',
                },
              };
  return {
    name: name ?? `Attente : ${waitSummary(spec)}`,
    expect,
    timeoutMs: Math.max(WAIT_TIMEOUT.min, spec.timeoutS) * 1000,
    ...(spec.onTimeout === 'WARN' ? { optional: true } : {}),
  };
}

export const WAIT_TYPE_LABELS: Readonly<Record<WaitType, string>> = {
  VISIBLE: 'Attendre un élément (visible)',
  HIDDEN: 'Attendre la disparition d’un élément',
  TEXT: 'Attendre un texte métier',
  URL: 'Attendre un changement d’adresse',
  RESPONSE: 'Attendre une réponse HTTP',
};

/** Les attentes que le moteur ne sait pas faire : montrées, jamais réglables. */
export const WAIT_UNSUPPORTED: readonly { label: string; reason: string }[] = [
  {
    label: 'Attendre qu’un élément soit cliquable',
    reason: 'le moteur vérifie la visibilité, pas l’état cliquable',
  },
  { label: 'Durée fixe', reason: 'le moteur n’a pas d’étape de pause : préférez une attente conditionnelle' },
];

/** Le résumé court d'une attente (étiquette du nœud, nom de l'étape). */
export function waitSummary(spec: WaitSpec): string {
  switch (spec.type) {
    case 'VISIBLE':
      return `${spec.selector ?? `« ${spec.text ?? '?'} »`} visible`;
    case 'HIDDEN':
      return `${spec.selector ?? `« ${spec.text ?? '?'} »`} disparu`;
    case 'TEXT':
      return `texte « ${spec.text ?? '?'} »`;
    case 'URL':
      return `adresse contient « ${spec.url ?? '?'} »`;
    case 'RESPONSE':
      return `${spec.method ? `${spec.method} ` : ''}${spec.url ?? '?'} → ${String(spec.status ?? '2xx')}`;
  }
}
