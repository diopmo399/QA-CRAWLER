import type { FlowTarget } from '../../config/flow-schema.js';
import type { LocatorQuality } from '../model.js';

/**
 * LE LOCALISATEUR DE PLAYWRIGHT, lu sur l'élément réellement touché (jamais deviné) : le sélecteur
 * interne que Playwright génère (`internal:role=button[name="Continuer"i]`), traduit en cible de
 * flow quand il en a une forme stable. Fonctions pures : aucune page, aucun navigateur.
 */
export type PlaywrightLocatorStrategy =
  'testId' | 'role' | 'label' | 'placeholder' | 'altText' | 'title' | 'text' | 'css' | 'chained';

export interface PlaywrightTargetEvidence {
  /** RESOLVED : localisateur lu et compté ; UNAVAILABLE : l'élément n'était plus là, ou l'API manque. */
  status: 'RESOLVED' | 'UNAVAILABLE';
  /** Le sélecteur interne de Playwright (`internal:role=…`). */
  selector?: string;
  /** Sa forme lisible : `getByRole('button', { name: 'Continuer' })`. */
  locator?: string;
  strategy?: PlaywrightLocatorStrategy;
  /** Combien d'éléments ce localisateur désigne dans la page, au moment de l'action. */
  matchCount?: number;
  /** Il désigne l'élément touché lui-même (jamais un voisin). */
  sameElement?: boolean;
  /** La cible de flow équivalente (seulement pour une forme stable, unique et sur le même élément). */
  target?: FlowTarget;
  /** Qualité équivalente dans l'échelle du recorder. */
  quality?: LocatorQuality;
  reason?: string;
  durationMs?: number;
}

/**
 * La priorité des formes (à la manière de Playwright) : 1 = la meilleure. La position (nth) n'est
 * jamais une forme retenue ici : le recorder actuel garde ce dernier recours.
 */
export const LOCATOR_PRIORITY: Record<PlaywrightLocatorStrategy, number> = {
  testId: 1,
  role: 2,
  label: 3,
  placeholder: 4,
  altText: 5,
  title: 5,
  text: 6,
  css: 8,
  chained: 9,
};

const QUALITY: Record<PlaywrightLocatorStrategy, LocatorQuality> = {
  testId: 'STABLE_ATTRIBUTE',
  role: 'SEMANTIC',
  label: 'SEMANTIC',
  placeholder: 'ACCESSIBLE',
  altText: 'ACCESSIBLE',
  title: 'ACCESSIBLE',
  text: 'ACCESSIBLE',
  css: 'CSS_STABLE',
  chained: 'FRAGILE',
};

/** `"Continuer"i` → Continuer ; `"x\"y"s` → x"y. */
function quoted(raw: string): { value: string; exact: boolean } | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"([is])?$/.exec(raw.trim());
  if (!match) return undefined;
  return { value: (match[1] ?? '').replace(/\\(.)/g, '$1'), exact: match[2] === 's' };
}

/**
 * Le sélecteur interne de Playwright → sa forme et, si elle est stable, la cible de flow. Un
 * sélecteur chaîné (`a >> b`), positionnel (`nth=`) ou dans un cadre n'est jamais traduit.
 */
export function parsePlaywrightSelector(selector: string): {
  strategy: PlaywrightLocatorStrategy;
  target?: FlowTarget;
} {
  const trimmed = selector.trim();
  if (
    trimmed.includes(' >> ') ||
    /(^|\s)nth=/.test(trimmed) ||
    trimmed.includes('internal:control=enter-frame')
  )
    return { strategy: 'chained' };
  const role = /^internal:role=([a-z]+)(.*)$/.exec(trimmed);
  if (role) {
    const name = /\[name=("(?:[^"\\]|\\.)*"[is]?)\]/.exec(role[2] ?? '');
    const parsed = name?.[1] ? quoted(name[1]) : undefined;
    // Un rôle sans nom (« le bouton ») ne désigne rien de précis : jamais une cible.
    return parsed?.value
      ? { strategy: 'role', target: { strategy: 'role', role: role[1] ?? '', name: parsed.value } }
      : { strategy: 'role' };
  }
  const testId = /^internal:testid=\[data-testid=("(?:[^"\\]|\\.)*"[is]?)\]$/.exec(trimmed);
  if (testId?.[1]) {
    const parsed = quoted(testId[1]);
    return parsed
      ? { strategy: 'testId', target: { strategy: 'testId', value: parsed.value } }
      : { strategy: 'testId' };
  }
  const label = /^internal:label=("(?:[^"\\]|\\.)*"[is]?)$/.exec(trimmed);
  if (label?.[1]) {
    const parsed = quoted(label[1]);
    return parsed
      ? { strategy: 'label', target: { strategy: 'label', value: parsed.value } }
      : { strategy: 'label' };
  }
  const attr = /^internal:attr=\[(placeholder|alt|title)=("(?:[^"\\]|\\.)*"[is]?)\]$/.exec(trimmed);
  if (attr?.[1] && attr[2]) {
    const parsed = quoted(attr[2]);
    const strategy = attr[1] === 'placeholder' ? 'placeholder' : attr[1] === 'alt' ? 'altText' : 'title';
    // Le flow n'a pas de forme « placeholder » : l'attribut stable, par sélecteur.
    return parsed
      ? {
          strategy,
          target: { strategy: 'css', value: `[${attr[1]}="${parsed.value.replace(/"/g, '\\"')}"]` },
        }
      : { strategy };
  }
  const text = /^internal:text=("(?:[^"\\]|\\.)*"[is]?)$/.exec(trimmed);
  if (text?.[1]) {
    const parsed = quoted(text[1]);
    return parsed
      ? { strategy: 'text', target: { strategy: 'text', value: parsed.value } }
      : { strategy: 'text' };
  }
  if (trimmed.startsWith('internal:')) return { strategy: 'chained' };
  // Un CSS propre (id, attribut) : gardé seulement s'il ne dit pas une position.
  if (/:nth-|:first-|:last-/.test(trimmed)) return { strategy: 'chained' };
  return { strategy: 'css', target: { strategy: 'css', value: trimmed } };
}

/** La qualité, dans l'échelle du recorder, d'une forme Playwright. */
export function qualityOf(strategy: PlaywrightLocatorStrategy): LocatorQuality {
  return QUALITY[strategy];
}

/**
 * La preuve est-elle une cible utilisable ? Seulement si Playwright désigne UN élément, le même que
 * celui touché, par une forme stable.
 */
export function usableEvidence(
  evidence: PlaywrightTargetEvidence | undefined,
): evidence is PlaywrightTargetEvidence & { target: FlowTarget; strategy: PlaywrightLocatorStrategy } {
  return (
    evidence?.status === 'RESOLVED' &&
    evidence.matchCount === 1 &&
    evidence.sameElement === true &&
    evidence.target !== undefined &&
    evidence.strategy !== undefined &&
    evidence.strategy !== 'chained'
  );
}

/** Ce que le recorder a capturé de l'élément AVANT le geste (rôle, nom, libellé, texte, test id…). */
export interface TouchedIdentity {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  testId?: string;
  placeholder?: string;
}

/**
 * Le localisateur de Playwright décrit-il l'élément tel qu'il était AVANT le geste ? Playwright lit
 * la page après l'action : un bouton « Confirmer » devenu « Confirmé » ne serait plus retrouvé au
 * rejeu. Seul un localisateur cohérent avec l'élément capturé est retenu.
 */
export function consistentWithTouched(target: FlowTarget, touched: TouchedIdentity): boolean {
  const same = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && normalized(a) === normalized(b);
  const names = [touched.name, touched.label, touched.text];
  switch (target.strategy) {
    case 'role':
      return target.role === touched.role && names.some((name) => same(target.name, name));
    case 'label':
      return [touched.label, touched.name].some((name) => same(target.value, name));
    case 'text':
      return [touched.text, touched.name].some((name) => same(target.value, name));
    case 'testId':
      return same(target.value, touched.testId);
    default: {
      const placeholder = /^\[placeholder="(.*)"\]$/.exec(target.value ?? '');
      return placeholder ? same(placeholder[1]?.replace(/\\"/g, '"'), touched.placeholder) : true;
    }
  }
}

function normalized(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
