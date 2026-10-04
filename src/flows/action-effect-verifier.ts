import type { FlowTarget, StepEffects, TargetFingerprint } from '../config/flow-schema.js';
import type { ElementHandle, Locator, Page } from 'playwright';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { sectionPathExpression } from '../recording/semantic-dom.js';

/**
 * CLICKED != SUCCEEDED. Playwright qui clique sans erreur prouve seulement que le clic a eu
 * lieu ; l'action n'est FONCTIONNELLEMENT réussie que si son effet attendu est observé.
 *
 *   CONFIRMED     un effet attendu est là (contrôle apparu, route, requête, cible suivante)
 *   NO_EFFECT     rien d'attendu, rien de changé : le clic n'a rien produit
 *   WRONG_EFFECT  l'écran a changé, mais pas comme pendant l'enregistrement (mauvaise cible ?)
 *   AMBIGUOUS     une écriture partie sans réponse claire : jamais rejouée automatiquement
 *   NOT_REQUIRED  aucun effet à exiger (rien appris, ou `effects.required: false`)
 *   NOT_VERIFIED  vérification désactivée, ou seule la cible suivante était attendue et l'écran a changé
 */
export type EffectStatus =
  'CONFIRMED' | 'NO_EFFECT' | 'WRONG_EFFECT' | 'AMBIGUOUS' | 'NOT_REQUIRED' | 'NOT_VERIFIED';

export type FingerprintVerdict = 'EXACT_MATCH' | 'STRONG_MATCH' | 'WEAK_MATCH' | 'MISMATCH';

/** Ce que l'élément trouvé au rejeu dit de lui-même (jamais une valeur saisie). */
export interface ObservedTarget {
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  /** Le chemin de sections de l'élément trouvé (« Général », « Colonnes > Disponibles »). */
  section?: string;
  /** La fenêtre qui le contient (aria-label ou titre). */
  dialog?: string;
  id?: string;
  inputType?: string;
}

export interface FingerprintMatch {
  verdict: FingerprintVerdict;
  score: number;
  reasons: string[];
  /**
   * Les composantes, séparées (jamais seulement MATCH / MISMATCH) : identité (testId, nom, rôle),
   * contexte (section, fenêtre, champ), sémantique (libellé), structure (id, balise, type).
   */
  components?: { identity: number; context: number; semantic: number; structural: number };
  matchedEvidence?: string[];
  mismatchedEvidence?: string[];
  /** HARD : une autre identité (autre nom, autre section) ; SOFT : un contexte qui a bougé (fenêtre renommée). */
  severity?: 'NONE' | 'SOFT' | 'HARD';
}

export interface ObservedEffects {
  appeared: string[];
  disappeared: string[];
  routeChanged?: string;
  requests: string[];
}

export interface EffectVerification {
  status: EffectStatus;
  expected: string[];
  observed: string[];
  reasons: string[];
}

export const normalize = (text: string | undefined): string =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[*:]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * TARGET FINGERPRINT MATCHER : l'élément trouvé est-il celui que l'humain a cliqué ? Un CSS
 * structurel (main > div:nth-of-type(3)) peut désigner un autre élément après un changement
 * de l'écran : le nom, le texte, le test id et le rôle le disent avant de cliquer.
 */
function baseMatch(expected: TargetFingerprint, observed: ObservedTarget): FingerprintMatch {
  const reasons: string[] = [];
  // Rien n'a pu être lu (élément détaché, re-rendu) : ce n'est PAS la preuve d'un autre élément.
  if (observed.tag === undefined && !observed.role && !observed.name && !observed.text && !observed.testId)
    return {
      verdict: 'MISMATCH',
      score: 0,
      reasons: ['the located element could not be read (detached or re-rendered)'],
    };
  if (expected.testId && observed.testId) {
    if (expected.testId === observed.testId)
      return { verdict: 'EXACT_MATCH', score: 1, reasons: ['same test id'] };
    return {
      verdict: 'MISMATCH',
      score: 0,
      reasons: [`test id "${observed.testId}" instead of "${expected.testId}"`],
    };
  }
  const wanted = normalize(expected.name ?? expected.text);
  const found = [normalize(observed.name), normalize(observed.text)].filter(Boolean);
  let score = 0;
  if (wanted) {
    if (found.some((text) => text === wanted)) {
      score += 0.7;
      reasons.push('same accessible name');
    } else if (found.some((text) => text.includes(wanted) || (text.length >= 3 && wanted.includes(text)))) {
      score += 0.45;
      reasons.push('name contains the recorded one');
    } else {
      reasons.push(
        `"${observed.name ?? observed.text ?? ''}" instead of "${expected.name ?? expected.text ?? ''}"`,
      );
    }
  } else score += 0.4;
  if (expected.role && observed.role) {
    if (expected.role === observed.role) {
      score += 0.2;
      reasons.push('same role');
    } else {
      score -= 0.15;
      reasons.push(`role ${observed.role} instead of ${expected.role}`);
    }
  }
  if (expected.tag && observed.tag && expected.tag === observed.tag) score += 0.1;
  // LE CONTEXTE : un élément identique d'une AUTRE section n'est pas la cible (Filtres ≠ Général).
  const context = sectionMatch(expected.section, observed.section);
  if (context === 'OTHER')
    return {
      verdict: 'MISMATCH',
      score: 0,
      reasons: [...reasons, `section "${observed.section ?? ''}" instead of "${expected.section ?? ''}"`],
    };
  if (context === 'SAME') {
    score += 0.1;
    reasons.push('same section');
  }
  score = Math.max(0, Math.min(1, score));
  const verdict: FingerprintVerdict =
    score >= 0.9 ? 'EXACT_MATCH' : score >= 0.7 ? 'STRONG_MATCH' : score >= 0.45 ? 'WEAK_MATCH' : 'MISMATCH';
  return { verdict, score: Number(score.toFixed(2)), reasons };
}

/**
 * TARGET FINGERPRINT MATCHER : le verdict historique (nom, rôle, balise, section), complété par des
 * composantes et des preuves explicables. La fenêtre et le champ enregistrés (identité contextualisée)
 * ne changent le verdict que par leur sévérité : une fenêtre renommée est un écart SOFT, un autre nom
 * ou une autre section un écart HARD.
 */
export function matchFingerprint(expected: TargetFingerprint, observed: ObservedTarget): FingerprintMatch {
  const base = baseMatch(expected, observed);
  const matched: string[] = [];
  const mismatched: string[] = [];
  const components = { identity: 0, context: 0, semantic: 0, structural: 0 };
  const same = (a: string | undefined, b: string | undefined): boolean | undefined =>
    a === undefined || b === undefined ? undefined : normalize(a) === normalize(b);
  const check = (
    kind: keyof typeof components,
    label: string,
    result: boolean | undefined,
    weight: number,
  ): void => {
    if (result === undefined) return;
    if (result) {
      components[kind] += weight;
      matched.push(label);
    } else mismatched.push(label);
  };
  check('identity', 'TEST_ID', same(expected.testId, observed.testId), 1);
  const wanted = expected.name ?? expected.text;
  const found = observed.name ?? observed.text;
  check('identity', 'ACCESSIBLE_NAME', same(wanted, found), 0.6);
  check('identity', 'ROLE', same(expected.role, observed.role), 0.4);
  check('semantic', 'LABEL', same(expected.label ?? expected.formField, observed.name), 1);
  const section = sectionMatch(expected.section, observed.section);
  check('context', 'SECTION', section === 'UNKNOWN' ? undefined : section === 'SAME', 0.5);
  check('context', 'DIALOG', same(expected.dialog, observed.dialog), 0.5);
  check('structural', 'ID', same(expected.id, observed.id), 0.5);
  check('structural', 'TAG', same(expected.tag, observed.tag), 0.3);
  check('structural', 'INPUT_TYPE', same(expected.inputType, observed.inputType), 0.2);
  // Une autre identité (nom, section, testId) : HARD. Seule la fenêtre ou la structure a bougé : SOFT.
  const hard = mismatched.some((evidence) =>
    ['TEST_ID', 'ACCESSIBLE_NAME', 'SECTION', 'LABEL'].includes(evidence),
  );
  const severity = mismatched.length === 0 ? 'NONE' : hard || base.verdict === 'MISMATCH' ? 'HARD' : 'SOFT';
  const round = (value: number): number => Number(Math.min(1, value).toFixed(2));
  return {
    ...base,
    reasons: [
      ...base.reasons,
      ...(expected.dialog && observed.dialog && same(expected.dialog, observed.dialog) === false
        ? [`dialog "${observed.dialog}" instead of "${expected.dialog}" (soft)`]
        : []),
    ],
    components: {
      identity: round(components.identity),
      context: round(components.context),
      semantic: round(components.semantic),
      structural: round(components.structural),
    },
    matchedEvidence: matched,
    mismatchedEvidence: mismatched,
    severity,
  };
}

/**
 * La section trouvée est-elle celle attendue ? SAME (même chemin, ou la section attendue la plus
 * précise s'y retrouve), OTHER (une autre section connue), UNKNOWN (rien à comparer).
 */
export function sectionMatch(
  expected: string | undefined,
  observed: string | undefined,
): 'SAME' | 'OTHER' | 'UNKNOWN' {
  const parts = (text: string | undefined): string[] =>
    (text ?? '')
      .split('>')
      .map((part) => normalize(part))
      .filter(Boolean);
  const wanted = parts(expected);
  const found = parts(observed);
  if (wanted.length === 0 || found.length === 0) return 'UNKNOWN';
  if (wanted.join('>') === found.join('>')) return 'SAME';
  return found.includes(wanted[wanted.length - 1] ?? '') ? 'SAME' : 'OTHER';
}

let probes = 0;

/**
 * LOCATOR CANDIDATES (healing) : les autres façons de trouver LE MÊME élément, à partir de son
 * empreinte — rôle + nom, test id, texte. Jamais « n'importe quel élément cliquable ».
 */
export function healingCandidates(fingerprint: TargetFingerprint, current: FlowTarget): FlowTarget[] {
  const candidates: FlowTarget[] = [];
  if (fingerprint.role && fingerprint.name)
    candidates.push({ strategy: 'role', role: fingerprint.role, name: fingerprint.name });
  if (fingerprint.testId) candidates.push({ strategy: 'testId', value: fingerprint.testId });
  if (fingerprint.name) candidates.push({ strategy: 'text', value: fingerprint.name });
  if (fingerprint.text && fingerprint.text !== fingerprint.name)
    candidates.push({ strategy: 'text', value: fingerprint.text });
  const same = (a: FlowTarget, b: FlowTarget): boolean =>
    a.strategy === b.strategy && a.value === b.value && a.role === b.role && a.name === b.name;
  return candidates.filter((candidate) => !same(candidate, current));
}

/** Un locator CSS structurel (positions) : il peut viser un autre élément après un changement d'écran. */
export function isFragileTarget(target: FlowTarget): boolean {
  return target.strategy === 'css' && /:nth-(of-type|child)|>\s*div|^main\b|^body\b/.test(target.value ?? '');
}

/** Les contrôles visibles d'un écran : role:nom (et le nom seul, pour un rôle qui a changé). */
export function controlsOf(snapshot: UiSnapshot | undefined): Set<string> {
  const controls = new Set<string>();
  for (const element of snapshot?.elements ?? []) {
    if (!element.visible || !element.role) continue;
    const name = normalize(element.name);
    if (!name) continue;
    controls.add(`${element.role}:${name}`);
  }
  return controls;
}

/** Ce que l'action a changé : contrôles apparus / disparus, route, requêtes. */
export function observeEffects(
  before: Set<string>,
  after: Set<string>,
  beforeRoute: string,
  afterRoute: string,
  requests: readonly string[],
): ObservedEffects {
  return {
    appeared: [...after].filter((control) => !before.has(control)),
    disappeared: [...before].filter((control) => !after.has(control)),
    ...(beforeRoute !== afterRoute ? { routeChanged: afterRoute } : {}),
    requests: [...requests],
  };
}

/**
 * Les rôles qui peuvent se remplacer pour un MÊME contrôle (un re-rendu lit un bouton comme un lien,
 * un champ texte comme une liste à saisie) : jamais un bouton pour un dialogue, ni un champ pour un onglet.
 */
const ROLE_FAMILIES: readonly (readonly string[])[] = [
  ['button', 'link', 'menuitem'],
  ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  ['dialog', 'alertdialog'],
  ['checkbox', 'switch', 'menuitemcheckbox'],
  ['radio', 'menuitemradio'],
  ['tab'],
  ['listbox', 'menu', 'grid', 'tree', 'table'],
  ['option', 'row', 'treeitem'],
];

/** Deux rôles désignent-ils le même genre de contrôle ? */
export function compatibleRoles(expected: string, observed: string): boolean {
  if (expected === observed) return true;
  return ROLE_FAMILIES.some((family) => family.includes(expected) && family.includes(observed));
}

/**
 * « button:Suivant » ou « Suivant » présent à l'écran. Avec un rôle, le nom seul ne suffit pas : le
 * rôle observé doit être de la même famille (un re-rendu peut lire un bouton comme un lien, jamais
 * un bouton « Filter » comme le dialogue « Filter »). Sans rôle, le nom suffit.
 */
export function present(controls: Set<string>, expected: string): boolean {
  const colon = expected.indexOf(':');
  const role = colon > 0 && !expected.slice(0, colon).includes(' ') ? expected.slice(0, colon) : undefined;
  const name = normalize(role ? expected.slice(colon + 1) : expected);
  if (role && controls.has(`${role}:${name}`)) return true;
  for (const control of controls) {
    const separator = control.indexOf(':');
    if (control.slice(separator + 1) !== name) continue;
    if (!role || compatibleRoles(role, control.slice(0, separator))) return true;
  }
  return false;
}

/** /demandes/{id} correspond à /demandes/42 ; un chemin sans paramètre se compare tel quel. */
export function routeMatches(pattern: string, route: string): boolean {
  const escaped = pattern
    .split(/(\{[^}]+\}|:[A-Za-z]\w*)/)
    .map((part) =>
      /^(\{[^}]+\}|:[A-Za-z]\w*)$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${escaped}/?$`).test(route.split('?')[0] ?? route);
}

/** « POST /api/requests » contre les requêtes observées (« POST /api/requests 201 »). */
export function requestMatches(expected: string, requests: readonly string[]): string | undefined {
  const [method, path] = expected.split(' ');
  if (!method || !path) return undefined;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  return requests.find((request) => {
    const [observedMethod, observedPath, status] = request.split(' ');
    // Une écriture refusée (4xx, 5xx) n'est pas l'effet attendu : elle a été tentée, pas réussie.
    if (write && status !== undefined && Number(status) >= 400) return false;
    return (
      observedMethod === method.toUpperCase() &&
      observedPath !== undefined &&
      routeMatches(path, observedPath)
    );
  });
}

/**
 * ACTION EFFECT VERIFIER : les effets attendus (appris à l'enregistrement, et la cible de
 * l'étape suivante si elle n'était pas là avant) comparés aux effets observés.
 */
export function verifyEffects(input: {
  effects?: StepEffects;
  observed: ObservedEffects;
  afterControls: Set<string>;
  afterRoute: string;
  /** La cible de l'étape suivante : absente avant l'action ? présente après ? */
  nextTarget?: { label: string; before: boolean; after: boolean };
  /** L'action écrit (MUTATION) : une écriture sans réponse claire est AMBIGUOUS. */
  mutation: boolean;
  /** Statut des écritures observées (undefined : sans réponse). */
  writes: { request: string; status?: number }[];
}): EffectVerification {
  const expected: string[] = [];
  const met: string[] = [];
  const effects = input.effects;
  // APPARU : présent après ET absent avant (un contrôle déjà là n'est pas l'effet de l'action).
  const appeared = new Set(input.observed.appeared);
  const before = new Set(
    [...input.afterControls].filter((control) => !appeared.has(control)).concat(input.observed.disappeared),
  );
  for (const control of effects?.appears ?? []) {
    expected.push(`+ ${control}`);
    if (present(input.afterControls, control) && !present(before, control)) met.push(`+ ${control}`);
  }
  for (const control of effects?.disappears ?? []) {
    expected.push(`- ${control}`);
    if (!present(input.afterControls, control)) met.push(`- ${control}`);
  }
  if (effects?.route) {
    expected.push(`route ${effects.route}`);
    if (routeMatches(effects.route, input.afterRoute)) met.push(`route ${input.afterRoute}`);
  }
  if (effects?.request) {
    expected.push(`request ${effects.request}`);
    const seen = requestMatches(effects.request, input.observed.requests);
    if (seen) met.push(`request ${seen}`);
  }
  if (input.nextTarget && !input.nextTarget.before) {
    expected.push(`next target "${input.nextTarget.label}" available`);
    if (input.nextTarget.after) met.push(`next target "${input.nextTarget.label}" available`);
  }
  const observed = [
    ...input.observed.appeared.slice(0, 5).map((control) => `+ ${control}`),
    ...input.observed.disappeared.slice(0, 3).map((control) => `- ${control}`),
    ...(input.observed.routeChanged ? [`route ${input.observed.routeChanged}`] : []),
    ...input.observed.requests.slice(0, 3).map((request) => `request ${request}`),
  ];
  // Une écriture partie sans réponse claire : on ne sait pas si l'effet métier a eu lieu.
  if (input.mutation) {
    const accepted = input.writes.some(
      (write) => write.status !== undefined && write.status >= 200 && write.status < 300,
    );
    const unclear = input.writes.some((write) => write.status === undefined || write.status >= 500);
    if (!accepted && unclear && met.length === 0)
      return {
        status: 'AMBIGUOUS',
        expected,
        observed,
        reasons: [
          'a write was sent without a clear answer: it may have happened, it is never replayed automatically',
        ],
      };
  }
  if (effects?.required === false)
    return { status: 'NOT_REQUIRED', expected, observed, reasons: ['effects.required: false'] };
  if (expected.length === 0)
    return { status: 'NOT_REQUIRED', expected, observed, reasons: ['no effect learned for this action'] };
  if (met.length > 0)
    return {
      status: 'CONFIRMED',
      expected,
      observed,
      reasons: [`observed: ${met.join(', ')}`],
    };
  const changed = observed.length > 0;
  // Seule attente : la cible suivante. L'écran a changé : un écran intermédiaire (étape insérée,
  // dry run) est possible, l'étape suivante dira si c'est une divergence. Rien n'a bougé : NO_EFFECT.
  const learned = expected.length - (input.nextTarget && !input.nextTarget.before ? 1 : 0);
  if (learned === 0 && changed)
    return {
      status: 'NOT_VERIFIED',
      expected,
      observed,
      reasons: ['the screen changed, the next step target is not available yet (intermediate screen?)'],
    };
  return {
    status: changed ? 'WRONG_EFFECT' : 'NO_EFFECT',
    expected,
    observed,
    reasons: [
      changed
        ? 'the screen changed, but not as during the recording (wrong target, or the application changed)'
        : 'click executed, no expected effect observed (nothing changed)',
    ],
  };
}

/** Ce que l'élément trouvé dit de lui (rôle, nom, texte, test id) — jamais la valeur d'un champ. */
export async function readTarget(target: Locator | ElementHandle, page?: Page): Promise<ObservedTarget> {
  // Un localisateur ou un élément déjà tenu (validation pendant l'enregistrement) : la même lecture.
  const locator = target as Locator;
  const observed = await locator
    .evaluate((el) => {
      const clean = (text: string | null | undefined): string =>
        (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const tag = el.tagName.toLowerCase();
      const implicit: Record<string, string> = {
        button: 'button',
        a: 'link',
        select: 'combobox',
        textarea: 'textbox',
      };
      const input = el as HTMLInputElement;
      const role =
        el.getAttribute('role') ??
        (tag === 'input'
          ? ['button', 'submit', 'reset'].includes(input.type)
            ? 'button'
            : input.type === 'checkbox'
              ? 'checkbox'
              : input.type === 'radio'
                ? 'radio'
                : 'textbox'
          : implicit[tag]);
      const field =
        ['input', 'select', 'textarea'].includes(tag) || ['textbox', 'combobox'].includes(role ?? '');
      // Le libellé d'un champ comme la capture le lit : aria-labelledby, <label> (sans les contrôles
      // qu'il contient), le libellé d'un mat-form-field — sinon le rejeu croirait le nom « vide ».
      const labelText = (node: Element | null | undefined): string => {
        if (!node) return '';
        const copy = node.cloneNode(true) as Element;
        for (const control of Array.from(copy.querySelectorAll('select, textarea, input, option')))
          control.remove();
        return clean(copy.textContent).replace(/[*:\s]+$/, '');
      };
      const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => labelText(document.getElementById(id)))
        .join(' ')
        .trim();
      const label = field
        ? labelledBy ||
          labelText(input.labels?.[0]) ||
          labelText(el.closest('label')) ||
          labelText(el.closest('mat-form-field, .mat-mdc-form-field')?.querySelector('mat-label, label'))
        : '';
      // Un champ natif n'a pas de texte (jamais sa valeur) ; une liste maison (mat-select) garde le sien.
      const native = ['input', 'select', 'textarea'].includes(tag);
      const text = native ? '' : clean((el as HTMLElement).innerText || el.textContent);
      const name =
        clean(el.getAttribute('aria-label')) ||
        label ||
        text ||
        clean(el.getAttribute('title')) ||
        (field ? clean(el.getAttribute('placeholder')) : '');
      const testId = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']
        .map((attribute) => el.getAttribute(attribute))
        .find((value) => value);
      const dialogBox = el.closest(
        '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"], mat-dialog-container',
      );
      const dialog = dialogBox
        ? clean(
            dialogBox.getAttribute('aria-label') ??
              dialogBox.querySelector('h1, h2, h3, [role="heading"]')?.textContent,
          )
        : '';
      const id = el.getAttribute('id');
      return {
        tag,
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(text ? { text } : {}),
        ...(testId ? { testId } : {}),
        ...(dialog ? { dialog } : {}),
        ...(id ? { id } : {}),
        ...(tag === 'input' ? { inputType: (input.type || 'text').toLowerCase() } : {}),
      };
    })
    .catch((): ObservedTarget => ({}));
  if (observed.tag === undefined) return observed;
  const section = await readSection(locator, page);
  return section ? { ...observed, section } : observed;
}

/** Le chemin de sections de l'élément (même calcul qu'à l'enregistrement) ; undefined s'il est illisible. */
export async function readSection(target: Locator | ElementHandle, page?: Page): Promise<string | undefined> {
  const locator = target as Locator;
  probes += 1;
  const token = `probe-${String(probes)}`;
  const marked = await locator
    .evaluate((el, value) => {
      el.setAttribute('data-qa-crawler-probe', value);
      return true;
    }, token)
    .catch(() => false);
  if (!marked) return undefined;
  const owner = page ?? (typeof locator.page === 'function' ? locator.page() : undefined);
  if (!owner) return undefined;
  const path = (await owner.evaluate(sectionPathExpression(token)).catch(() => null)) as string[] | null;
  return path && path.length > 0 ? path.join(' > ') : undefined;
}
