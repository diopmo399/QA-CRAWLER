/**
 * DISCRIMINATING CSS SELECTOR BUILDER : le CSS reste un localisateur de premier rang, mais il est
 * construit pour DISCRIMINER. Plusieurs candidats, du plus stable au plus fragile, sont testés sur le
 * DOM courant (querySelectorAll) ; le meilleur candidat UNIQUE et STABLE est préféré, le chemin
 * structurel est gardé en repli. UNIQUE ≠ BON : un chemin de positions unique reste fragile.
 *
 * `analyzeSelectors` s'exécute dans la page (sérialisé avec toString, comme sectionPathOf) : aucune
 * référence au module, ses aides lui sont passées. Les fonctions pures (détecteur d'attributs
 * dynamiques, confiance) sont testées seules et injectées telles quelles.
 */

export type CssCandidateKind =
  | 'TEST_ID'
  | 'STABLE_ID'
  | 'FORM_CONTROL'
  | 'NAME'
  | 'ARIA'
  | 'HOST_BINDING'
  | 'CONTEXTUAL'
  | 'COMPONENT'
  | 'STABLE_CLASS'
  | 'STRUCTURAL';

export interface CssLocatorCandidate {
  selector: string;
  kind: CssCandidateKind;
  matchCount: number;
  unique: boolean;
  stabilityScore: number;
  specificityScore: number;
  semanticScore: number;
  usesDynamicAttribute: boolean;
  usesStructuralIndex: boolean;
  evidence: string[];
  confidence: number;
}

export type AmbiguityLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';

export type AmbiguityReason =
  'GENERIC_CSS' | 'DYNAMIC_ID' | 'STRUCTURAL_ONLY' | 'NO_UNIQUE_SELECTOR' | 'REPEATED_LABEL';

export interface ElementAmbiguityInfo {
  level: AmbiguityLevel;
  reasons: AmbiguityReason[];
  /** Combien d'éléments le chemin structurel désignait. */
  structuralMatches: number;
}

/** L'identité portée par un ANCÊTRE (un composant hôte Angular, une section marquée…). */
export interface HostIdentity {
  tag: string;
  attribute: string;
  value: string;
  selector: string;
  depth: number;
}

export interface SelectorAnalysis {
  preferred?: CssLocatorCandidate;
  structural: CssLocatorCandidate;
  candidates: CssLocatorCandidate[];
  host?: HostIdentity;
  ambiguity: ElementAmbiguityInfo;
}

export type AttributeKind = 'id' | 'class' | 'attribute';

/**
 * DYNAMIC ATTRIBUTE DETECTOR : une valeur probablement GÉNÉRÉE (mat-input-0, cdk-overlay-3,
 * _ngcontent-abc, :r1:, uuid, classe css-in-js) n'est jamais une identité stable.
 */
export function isDynamicValue(kind: AttributeKind, value: string): boolean {
  const text = value.trim();
  if (text === '') return true;
  if (/^(mat|mdc|cdk|ng|ion|mui|react|ember|radix|headlessui|rc|el|ext|yui)[-_:].*\d/i.test(text))
    return true;
  if (/^_ng(content|host)/i.test(text) || /^ng-(tns|star|trigger)/i.test(text)) return true;
  if (text.startsWith(':') || /:r[0-9a-z]+:/i.test(text)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(text)) return true;
  if (/^(css|sc|jsx|emotion|svelte|styled)-[a-z0-9]{4,}$/i.test(text)) return true;
  // Un id ou une classe qui porte un numéro : un compteur probable (comme avant pour les ids).
  if (kind === 'id' || kind === 'class') return /\d/.test(text);
  // Un attribut métier (formControlName, name, data-*) : seulement une longue suite de chiffres ou un hachage.
  return /\d{3,}/.test(text) || (/^[a-z0-9]{16,}$/i.test(text) && /\d/.test(text) && /[a-z]/i.test(text));
}

/**
 * La confiance d'un candidat : unicité + stabilité + identité sémantique + concision — moins les
 * index structurels et les attributs générés. Un candidat non unique est fortement pénalisé.
 */
export function candidateConfidence(
  candidate: Pick<
    CssLocatorCandidate,
    | 'matchCount'
    | 'unique'
    | 'stabilityScore'
    | 'semanticScore'
    | 'specificityScore'
    | 'usesDynamicAttribute'
    | 'usesStructuralIndex'
  >,
): number {
  if (candidate.matchCount <= 0) return 0;
  let score =
    0.5 * candidate.stabilityScore + 0.35 * candidate.semanticScore + 0.15 * candidate.specificityScore;
  if (candidate.usesDynamicAttribute) score *= 0.5;
  if (candidate.usesStructuralIndex) score *= 0.7;
  if (!candidate.unique) score *= 1 / (1 + Math.log2(candidate.matchCount));
  return Math.round(score * 100) / 100;
}

/** Le classement : les candidats UNIQUES d'abord, puis la confiance. */
export function rankCandidates<T extends Pick<CssLocatorCandidate, 'unique' | 'confidence'>>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => Number(b.unique) - Number(a.unique) || b.confidence - a.confidence);
}

/** Le niveau d'ambiguïté d'un élément, d'après son analyse. */
export function ambiguityOf(input: {
  preferred: Pick<CssLocatorCandidate, 'usesStructuralIndex' | 'usesDynamicAttribute'> | undefined;
  structuralMatches: number;
  dynamicId: boolean;
}): ElementAmbiguityInfo {
  const reasons: AmbiguityReason[] = [];
  if (input.structuralMatches > 1) reasons.push('GENERIC_CSS');
  if (input.dynamicId) reasons.push('DYNAMIC_ID');
  const weak =
    input.preferred !== undefined &&
    (input.preferred.usesStructuralIndex || input.preferred.usesDynamicAttribute);
  if (weak) reasons.push('STRUCTURAL_ONLY');
  if (!input.preferred) reasons.push('NO_UNIQUE_SELECTOR');
  const level: AmbiguityLevel = !input.preferred
    ? 'HIGH'
    : weak
      ? 'MEDIUM'
      : reasons.length > 0
        ? 'LOW'
        : 'NONE';
  return { level, reasons, structuralMatches: input.structuralMatches };
}

export interface SelectorHelpers {
  isDynamic: (kind: AttributeKind, value: string) => boolean;
  confidence: typeof candidateConfidence;
  ambiguity: typeof ambiguityOf;
}

/**
 * L'ANALYSE, dans la page : les candidats CSS de l'élément (attributs propres, identité d'un ancêtre
 * hôte, contexte, composant, classes stables, chemin structurel), chacun compté sur le DOM courant.
 * Un candidat qui ne désigne pas l'élément est écarté. undefined dans un shadow DOM (le CSS y est
 * préfixé par l'hôte et querySelectorAll ne le lit pas).
 */
export function analyzeSelectors(el: Element, helpers: SelectorHelpers): SelectorAnalysis | undefined {
  if (typeof ShadowRoot !== 'undefined' && el.getRootNode() instanceof ShadowRoot) return undefined;
  const TEST_IDS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const BINDINGS = ['formcontrolname', 'formarrayname', 'formgroupname'];
  const ANCHOR_ATTRIBUTES = [
    ...TEST_IDS,
    ...BINDINGS,
    'name',
    'data-field',
    'data-section',
    'data-form',
    'id',
  ];
  const FRAMEWORK_CLASS = /^(mat|mdc|cdk|ng|ion|mui|v|el|ant|p|k|x)-/i;
  const BASE: Record<CssCandidateKind, [number, number]> = {
    TEST_ID: [0.98, 0.9],
    STABLE_ID: [0.9, 0.8],
    FORM_CONTROL: [0.95, 0.98],
    NAME: [0.9, 0.9],
    ARIA: [0.8, 0.85],
    HOST_BINDING: [0.94, 0.98],
    CONTEXTUAL: [0.88, 0.9],
    COMPONENT: [0.6, 0.5],
    STABLE_CLASS: [0.55, 0.4],
    STRUCTURAL: [0.3, 0.2],
  };
  const quote = (value: string): string => value.replace(/["\\]/g, '\\$&');
  const attr = (name: string, value: string): string => `[${name}="${quote(value)}"]`;
  const tag = el.tagName.toLowerCase();
  const candidates: CssLocatorCandidate[] = [];
  const seen = new Set<string>();
  const build = (
    selector: string,
    kind: CssCandidateKind,
    evidence: string[],
    dynamic = false,
  ): CssLocatorCandidate | undefined => {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      return undefined;
    }
    if (!matches.includes(el)) return undefined;
    const parts = selector.split(/\s*>\s*|\s+/).filter(Boolean).length;
    const [stabilityScore, semanticScore] = BASE[kind];
    const candidate: CssLocatorCandidate = {
      selector,
      kind,
      matchCount: matches.length,
      unique: matches.length === 1,
      stabilityScore,
      semanticScore,
      specificityScore: Math.max(0.2, Math.round((1 - 0.12 * (parts - 1)) * 100) / 100),
      usesDynamicAttribute: dynamic,
      usesStructuralIndex: /:nth-/.test(selector),
      evidence,
      confidence: 0,
    };
    candidate.confidence = helpers.confidence(candidate);
    return candidate;
  };
  const add = (selector: string, kind: CssCandidateKind, evidence: string[], dynamic = false): boolean => {
    if (seen.has(selector) || candidates.length >= 16) return false;
    seen.add(selector);
    const candidate = build(selector, kind, evidence, dynamic);
    if (candidate) candidates.push(candidate);
    return candidate?.unique === true && !dynamic;
  };

  // 1. Les attributs de l'élément lui-même.
  for (const name of TEST_IDS) {
    const value = el.getAttribute(name);
    if (value) add(attr(name, value), 'TEST_ID', [`${name}="${value}"`]);
  }
  const id = el.getAttribute('id');
  const dynamicId = id !== null && helpers.isDynamic('id', id);
  if (id)
    add(
      `#${typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id}`,
      'STABLE_ID',
      [`id="${id}"${dynamicId ? ' (generated)' : ''}`],
      dynamicId,
    );
  for (const name of BINDINGS) {
    const value = el.getAttribute(name);
    if (value && !helpers.isDynamic('attribute', value))
      add(`${tag}${attr(name, value)}`, 'FORM_CONTROL', [`${name}="${value}"`]);
  }
  const nameAttribute = el.getAttribute('name');
  if (nameAttribute && !helpers.isDynamic('attribute', nameAttribute))
    add(`${tag}${attr('name', nameAttribute)}`, 'NAME', [`name="${nameAttribute}"`]);
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length <= 60) add(`${tag}${attr('aria-label', aria)}`, 'ARIA', [`aria-label="${aria}"`]);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && placeholder.length <= 60)
    add(`${tag}${attr('placeholder', placeholder)}`, 'ARIA', [`placeholder="${placeholder}"`]);

  // 2. Les ANCÊTRES : une identité d'hôte (formControlName d'un composant maison, data-testid, name,
  // section marquée), puis la balise d'un composant maison.
  interface Anchor {
    node: Element;
    depth: number;
    selector: string;
    attribute?: string;
    value?: string;
    binding: boolean;
  }
  const anchors: Anchor[] = [];
  let node: Element | null = el.parentElement;
  for (
    let depth = 1;
    node && node !== document.body && node !== document.documentElement && depth <= 8;
    depth += 1
  ) {
    const nodeTag = node.tagName.toLowerCase();
    const custom = nodeTag.includes('-');
    for (const name of ANCHOR_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (!value || helpers.isDynamic(name === 'id' ? 'id' : 'attribute', value)) continue;
      anchors.push({
        node,
        depth,
        selector:
          name === 'id'
            ? `#${typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value}`
            : `${custom || name === 'name' ? nodeTag : ''}${attr(name, value)}`,
        attribute: name,
        value,
        binding: BINDINGS.includes(name) || TEST_IDS.includes(name),
      });
      break;
    }
    if (custom && !anchors.some((anchor) => anchor.node === node))
      anchors.push({ node, depth, selector: nodeTag, binding: false });
    node = node.parentElement;
  }
  const identified = anchors.filter((anchor) => anchor.attribute !== undefined);
  let found = candidates.some((candidate) => candidate.unique && !candidate.usesDynamicAttribute);
  // MINIMUM STABLE DISCRIMINATING SELECTOR : l'ancre la plus proche d'abord ; on s'arrête au premier unique.
  for (const anchor of identified) {
    const unique = add(`${anchor.selector} ${tag}`, anchor.binding ? 'HOST_BINDING' : 'CONTEXTUAL', [
      `${anchor.attribute ?? ''}="${anchor.value ?? ''}" on ancestor <${anchor.node.tagName.toLowerCase()}>`,
    ]);
    if (unique) {
      found = true;
      break;
    }
  }
  // Deux niveaux de contexte (une section marquée + l'hôte), seulement si rien n'est encore unique.
  if (!found)
    outer: for (const inner of identified.slice(0, 3))
      for (const outer of identified.filter((anchor) => anchor.depth > inner.depth).slice(0, 3))
        if (
          add(`${outer.selector} ${inner.selector} ${tag}`, 'CONTEXTUAL', [
            `${outer.attribute ?? ''}="${outer.value ?? ''}" > ${inner.attribute ?? ''}="${inner.value ?? ''}"`,
          ])
        ) {
          found = true;
          break outer;
        }
  for (const anchor of anchors.filter((entry) => entry.attribute === undefined).slice(0, 2))
    add(`${anchor.selector} ${tag}`, 'COMPONENT', [`inside <${anchor.selector}>`]);
  for (const name of Array.from(el.classList).slice(0, 6)) {
    if (FRAMEWORK_CLASS.test(name) || helpers.isDynamic('class', name)) continue;
    add(
      `${tag}.${typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(name) : name}`,
      'STABLE_CLASS',
      [`class "${name}"`],
    );
  }

  // 3. Le chemin STRUCTUREL (le CSS historique) : toujours gardé, en repli.
  const parts: string[] = [];
  let step: Element | null = el;
  for (let depth = 0; step && step !== document.body && depth < 5; depth += 1) {
    const parent: Element | null = step.parentElement;
    if (depth > 0 && step.tagName.includes('-') && !parts.some((part) => part.includes('-'))) {
      parts.unshift(step.tagName.toLowerCase());
      break;
    }
    const stepTag = step.tagName;
    const same = parent ? Array.from(parent.children).filter((child) => child.tagName === stepTag) : [];
    const position = same.length > 1 ? `:nth-of-type(${String(same.indexOf(step) + 1)})` : '';
    parts.unshift(`${stepTag.toLowerCase()}${position}`);
    step = parent;
  }
  const structuralSelector = parts.join(' > ');
  const structural = build(structuralSelector, 'STRUCTURAL', ['position in the page']) ?? {
    selector: structuralSelector,
    kind: 'STRUCTURAL' as const,
    matchCount: 0,
    unique: false,
    stabilityScore: BASE.STRUCTURAL[0],
    semanticScore: BASE.STRUCTURAL[1],
    specificityScore: 0.2,
    usesDynamicAttribute: false,
    usesStructuralIndex: /:nth-/.test(structuralSelector),
    evidence: ['position in the page'],
    confidence: 0,
  };
  if (!seen.has(structuralSelector) && structural.matchCount > 0) candidates.push(structural);

  const ranked = [...candidates].sort(
    (a, b) => Number(b.unique) - Number(a.unique) || b.confidence - a.confidence,
  );
  const preferred = ranked.find((candidate) => candidate.unique);
  const nearestHost = identified[0];
  return {
    ...(preferred ? { preferred } : {}),
    structural,
    candidates: ranked.slice(0, 8),
    ...(nearestHost?.attribute && nearestHost.value
      ? {
          host: {
            tag: nearestHost.node.tagName.toLowerCase(),
            attribute: nearestHost.attribute,
            value: nearestHost.value,
            selector: nearestHost.selector,
            depth: nearestHost.depth,
          },
        }
      : {}),
    ambiguity: helpers.ambiguity({
      preferred,
      structuralMatches: structural.matchCount,
      dynamicId,
    }),
  };
}

/** L'analyse, prête à être injectée dans une page : `(el) => SelectorAnalysis | undefined`. */
export function selectorAnalyzerSource(): string {
  // Les outils de transpilation peuvent insérer `__name(...)` : un remplacement neutre dans la page.
  return `((el) => { if (typeof globalThis.__name !== "function") { globalThis.__name = function (fn) { return fn; }; } return (${analyzeSelectors.toString()})(el, { isDynamic: ${isDynamicValue.toString()}, confidence: ${candidateConfidence.toString()}, ambiguity: ${ambiguityOf.toString()} }); })`;
}
