import type { FlowTarget, TargetFingerprint } from '../config/flow-schema.js';
import type { LocatorQuality, RecordedElement, RecordedTarget } from './model.js';
import { LOCATOR_PRIORITY, qualityOf, usableEvidence } from './sources/playwright-locator.js';

/** Rôles qu'une phrase Gherkin sait nommer (« le bouton », « le lien », « l'onglet », « le menu »). */
const CLICK_ROLES = new Set(['button', 'link', 'tab', 'menuitem']);
const FIELD_ROLES = new Set(['textbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'searchbox']);

/** Un nom qu'un humain lit (pas une icône, pas un identifiant technique). */
export function readable(text: string | undefined): text is string {
  return (
    text !== undefined &&
    text.length <= 80 &&
    /[\p{L}\p{N}]{2,}/u.test(text) &&
    !/^[a-z]+[A-Z][A-Za-z]*$/.test(text) &&
    !/^[\w-]*\d{3,}[\w-]*$/.test(text)
  );
}

export type TargetUse = 'click' | 'field' | 'check';

/**
 * Le localisateur d'une action enregistrée, du plus stable au plus fragile :
 *   SEMANTIC          libellé du champ, rôle + nom accessible d'un bouton / lien (ce que lit un humain)
 *   ACCESSIBLE        rôle + nom pour un champ, texte visible
 *   STABLE_ATTRIBUTE  data-testid, attribut name stable
 *   FRAMEWORK_BINDING formControlName
 *   CSS_STABLE        id non généré
 *   FRAGILE           chemin de positions (jamais #mat-input-23 ni nth-child, sauf en dernier recours)
 *
 * Un nom qui désigne plusieurs éléments (sans « exact », comme Playwright) n'est jamais
 * retenu tel quel : un attribut stable passe devant ; sinon la cible est AMBIGUË.
 */
export function resolveRecordedTarget(element: RecordedElement, use: TargetUse): RecordedTarget {
  const candidates: { target: FlowTarget; quality: LocatorQuality; unique: boolean; why: string }[] = [];
  const label = readable(element.label) ? element.label : undefined;
  const name = readable(element.name) ? element.name : undefined;
  const role = element.role;
  // L'IDENTITÉ CONTEXTUELLE : la section (« Colonnes > Colonnes disponibles ») distingue deux champs
  // identiques ; le libellé deviné (texte posé avant un champ non relié) est un nom humain, pas un CSS.
  const section =
    element.sectionPath && element.sectionPath.length > 0 ? element.sectionPath.join(' > ') : undefined;
  const guessed = !label && readable(element.guessedLabel) ? element.guessedLabel : undefined;
  const uniqueInSection = (element.sameLabelInSection ?? 0) <= 1;
  const semanticId = semanticIdOf(section, label ?? guessed ?? name);

  if (use === 'field' || use === 'check') {
    if (label)
      candidates.push({
        target: { strategy: 'label', value: label },
        quality: 'SEMANTIC',
        unique: element.sameLabel <= 1,
        why: `field label "${label}"`,
      });
    // Le même libellé ailleurs (« Rechercher » dans Colonnes et dans Filtres) : la section le rend unique.
    if (label && element.sameLabel > 1 && section && uniqueInSection)
      candidates.push({
        target: { strategy: 'label', value: label, section },
        quality: 'SEMANTIC',
        unique: true,
        why: `field label "${label}" in section "${section}"`,
      });
    // Sans section, le libellé deviné reste une intention (comportement historique) ; avec une
    // section connue, il devient une cible sémantique résolue dans son contexte.
    if (guessed && section && uniqueInSection)
      candidates.push({
        target: { strategy: 'label', value: guessed, section },
        quality: 'SEMANTIC',
        unique: true,
        why: `text before the field "${guessed}" in section "${section}"`,
      });
    if (use === 'check' && name && (role === 'checkbox' || role === 'radio' || role === 'switch'))
      candidates.push({
        target: { strategy: 'role', role, name },
        quality: 'ACCESSIBLE',
        unique: element.sameRoleName <= 1,
        why: `${role} "${name}"`,
      });
    if (use === 'field' && name && FIELD_ROLES.has(role) && name !== label)
      candidates.push({
        target: { strategy: 'label', value: name },
        quality: 'ACCESSIBLE',
        unique: element.sameRoleName <= 1,
        why: `accessible name "${name}"`,
      });
  } else {
    if (name && CLICK_ROLES.has(role))
      candidates.push({
        target: { strategy: 'role', role, name },
        quality: 'SEMANTIC',
        unique: element.sameRoleName <= 1,
        why: `${role} "${name}"`,
      });
    if (name && CLICK_ROLES.has(role) && element.sameRoleName > 1 && section)
      candidates.push({
        target: { strategy: 'role', role, name, section },
        quality: 'SEMANTIC',
        unique: true,
        why: `${role} "${name}" in section "${section}"`,
      });
    const text = element.text;
    if (readable(text) && text.length <= 60 && !CLICK_ROLES.has(role))
      candidates.push({
        target: { strategy: 'text', value: text },
        quality: 'ACCESSIBLE',
        unique: element.sameRoleName <= 1,
        why: `visible text "${text}"`,
      });
  }
  if (element.testId) {
    // getByTestId ne lit que data-testid : un autre attribut (data-qa, data-cy…) se vise par sélecteur.
    const attribute = element.testIdAttribute ?? 'data-testid';
    candidates.push({
      target:
        attribute === 'data-testid'
          ? { strategy: 'testId', value: element.testId }
          : { strategy: 'css', value: `[${attribute}="${element.testId}"]` },
      quality: 'STABLE_ATTRIBUTE',
      unique: true,
      why: `${attribute} "${element.testId}"`,
    });
  }
  if (element.nameAttr && !/\d{2,}/.test(element.nameAttr))
    candidates.push({
      target: { strategy: 'css', value: `${element.tag}[name="${element.nameAttr}"]` },
      quality: 'STABLE_ATTRIBUTE',
      unique: true,
      why: `name attribute "${element.nameAttr}"`,
    });
  // Un formControlName HÉRITÉ d'un hôte n'est pas sur l'élément : « [formcontrolname=x] » viserait l'hôte.
  if (element.formControlName && !element.formControlFromHost)
    candidates.push({
      target: { strategy: 'css', value: `[formcontrolname="${element.formControlName}"]` },
      quality: 'FRAMEWORK_BINDING',
      unique: true,
      why: `formControlName "${element.formControlName}"`,
    });
  if (element.elementId && !element.generatedId)
    candidates.push({
      target: { strategy: 'css', value: `#${element.elementId}` },
      quality: 'CSS_STABLE',
      // Un id dupliqué (#valueInput ×4) désigne plusieurs éléments : jamais une identité unique.
      unique: (element.sameId ?? 1) <= 1,
      why: `stable id "${element.elementId}"${(element.sameId ?? 1) > 1 ? ` (shared by ${String(element.sameId)} elements)` : ''}`,
    });
  // DISCRIMINATING CSS : le CSS capturé EST le candidat préféré (identité d'un hôte, contexte) quand le
  // CSS propre de l'élément ne le distinguait pas ; sa qualité est celle de son ancre.
  const preferred = element.selectors?.preferred;
  const discriminating =
    preferred !== undefined &&
    preferred.selector === element.css &&
    preferred.matchCount === 1 &&
    !preferred.structural &&
    !preferred.dynamic;
  const fragile: FlowTarget = { strategy: 'css', value: element.css };
  // SAME CSS ≠ SAME FIELD : un CSS qui désigne plusieurs éléments (« mat-form-field > … > input »)
  // n'est jamais déclaré unique ; l'empreinte (libellé du champ, contexte) le départage au rejeu.
  const cssMatches = element.cssMatches ?? 1;
  candidates.push({
    target: fragile,
    quality: discriminating
      ? preferred.kind === 'HOST_BINDING' || preferred.kind === 'FORM_CONTROL'
        ? 'FRAMEWORK_BINDING'
        : preferred.kind === 'TEST_ID' || preferred.kind === 'NAME'
          ? 'STABLE_ATTRIBUTE'
          : 'CSS_STABLE'
      : element.cssStable
        ? 'CSS_STABLE'
        : 'FRAGILE',
    unique: cssMatches <= 1,
    why: discriminating
      ? `discriminating selector ${element.css} (${preferred.kind}, unique, confidence ${String(preferred.confidence)})`
      : cssMatches > 1
        ? `generic selector (matches ${String(cssMatches)} elements)`
        : element.cssStable
          ? 'stable selector'
          : 'position in the page (fragile)',
  });

  // PLAYWRIGHT / HYBRID : le localisateur de Playwright, lu sur l'élément réellement touché, unique et
  // sur ce même élément. PLAYWRIGHT : il passe devant ; HYBRID : à son rang (testId, rôle + nom,
  // libellé, placeholder, texte, attribut, CSS) ; CURRENT : jamais présent.
  const playwright = element.playwright;
  let playwrightCandidate: (typeof candidates)[number] | undefined;
  if (usableEvidence(playwright)) {
    playwrightCandidate = {
      target: playwright.target,
      quality: qualityOf(playwright.strategy),
      unique: true,
      why: `Playwright locator ${playwright.locator ?? playwright.selector ?? ''} (unique, the touched element)`,
    };
    const rank = rankOf(playwrightCandidate);
    const at =
      playwright.mode === 'PLAYWRIGHT'
        ? 0
        : candidates.findIndex((candidate) => candidate.unique && rankOf(candidate) > rank);
    candidates.splice(at < 0 ? candidates.length - 1 : at, 0, playwrightCandidate);
  }

  // Rien d'unique : le chemin fragile (le dernier candidat), comme avant.
  const best = candidates.find((candidate) => candidate.unique) ?? candidates.at(-1);
  const first = candidates[0];
  const reasons: string[] = [];
  let chosen = best ?? { target: fragile, quality: 'FRAGILE' as const, unique: true, why: 'no locator' };
  let ambiguous = false;
  // Le CSS générique est le seul localisateur : l'empreinte départage-t-elle les candidats ?
  const distinguishing = [element.formField, element.placeholder, guessed, label, element.dialogName].some(
    (text) => readable(text),
  );
  if (first === chosen && !chosen.unique && chosen.target === fragile) {
    // Rien d'autre ne distingue le champ : SA position parmi les correspondances, enregistrée sur
    // l'élément que l'humain a réellement utilisé (dernier recours, jamais un « premier » arbitraire).
    const position = !distinguishing && element.cssIndex !== undefined ? element.cssIndex : undefined;
    ambiguous = !distinguishing && position === undefined;
    if (position !== undefined) chosen = { ...chosen, target: { ...fragile, nth: position } };
    reasons.push(
      `GENERIC_LOCATOR_DETECTED: ${chosen.why}; ${
        distinguishing
          ? `the fingerprint identifies the field (${[element.formField, element.placeholder, guessed, label].filter((text) => readable(text)).join(', ')})`
          : position !== undefined
            ? `nothing else distinguishes the field: recorded position ${String(position + 1)} of ${String(element.cssMatches ?? 0)} (last resort)`
            : 'nothing distinguishes the field'
      }`,
    );
  } else if (first && !first.unique && chosen.quality === 'FRAGILE') {
    // Le meilleur localisateur lisible désigne plusieurs éléments, et seul un chemin fragile reste.
    ambiguous = true;
    chosen = {
      ...first,
      target: { ...first.target, ...(element.roleNameIndex > 0 ? { nth: element.roleNameIndex } : {}) },
    };
    reasons.push(`${first.why} matches ${String(element.sameRoleName || element.sameLabel)} elements`);
  } else if (first && !first.unique && chosen !== first) {
    reasons.push(`${first.why} is not unique: ${chosen.why} used instead`);
  }
  reasons.unshift(`chosen: ${chosen.why} (${chosen.quality})`);
  if (playwright && !playwrightCandidate)
    reasons.push(
      `Playwright locator not used: ${playwright.locator ?? playwright.status}${
        playwright.reason
          ? ` (${playwright.reason})`
          : playwright.matchCount !== undefined
            ? ` (${String(playwright.matchCount)} match(es))`
            : ''
      }`,
    );
  const humanName = [
    label,
    name,
    element.guessedLabel,
    element.text,
    element.placeholder,
    element.formControlName,
    element.nameAttr,
  ].find((text): text is string => readable(text));
  const nearby = (element.nearbyText ?? []).filter((text) => readable(text)).slice(0, 4);
  // L'empreinte : ce qui identifie le MÊME élément au rejeu, même si son localisateur change.
  const fingerprint: TargetFingerprint = {
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(readable(element.text) && element.text !== name ? { text: element.text } : {}),
    ...(element.testId ? { testId: element.testId } : {}),
    tag: element.tag,
    ...(readable(element.context) ? { context: element.context } : {}),
    ...((label ?? guessed) ? { label: label ?? guessed } : {}),
    ...(section ? { section } : {}),
    ...(element.componentTag ? { component: element.componentTag } : {}),
    ...(element.formControlName ? { formControl: element.formControlName } : {}),
    ...(readable(element.placeholder) ? { placeholder: element.placeholder } : {}),
    ...(semanticId ? { semanticId } : {}),
    // IDENTITÉ CONTEXTUALISÉE : de quoi départager plusieurs éléments trouvés par le même localisateur.
    ...(element.elementId && !element.generatedId ? { id: element.elementId } : {}),
    ...(element.inputType ? { inputType: element.inputType } : {}),
    ...(element.dialogName && readable(element.dialogName) ? { dialog: element.dialogName } : {}),
    ...(element.formField && readable(element.formField) ? { formField: element.formField } : {}),
    ...(nearby.length > 0 ? { nearbyText: nearby } : {}),
    ...(element.nameAttr && !/\d{2,}/.test(element.nameAttr)
      ? { stableAttributes: { name: element.nameAttr } }
      : {}),
    // INTERACTION OWNER : le conteneur qui possède l'interaction, et le contexte structurel.
    ...(element.ownerKind && readable(element.ownerName)
      ? { owner: `${element.ownerKind}:${element.ownerName}` }
      : element.ownerKind === 'component' && element.ownerName
        ? { owner: `component:${element.ownerName}` }
        : {}),
    ...(readable(element.tab) ? { tab: element.tab } : {}),
    ...(readable(element.accordion) ? { accordion: element.accordion } : {}),
    ...(readable(element.form) ? { form: element.form } : {}),
    ...(readable(element.row) ? { row: element.row } : {}),
    ...(readable(element.listboxOwner) ? { listbox: element.listboxOwner } : {}),
    // DISCRIMINATING CSS : le préféré et le structurel (repli), comptés à l'enregistrement.
    ...cssRecordOf(element),
    ...(element.hostIdentity
      ? {
          host: `${element.hostIdentity.tag}[${element.hostIdentity.attribute}="${element.hostIdentity.value}"]`,
        }
      : {}),
    ...(element.maxLength !== undefined && element.maxLength > 0 && element.maxLength < 100_000
      ? { maxLength: element.maxLength }
      : {}),
    ...ambiguityRecordOf(element),
  };
  // TABLE ROW : la cible est dans une ligne de tableau dont une colonne est une clé unique — la ligne
  // est désignée par cette valeur (jamais par sa position : l'ordre du tableau change).
  let target = chosen.target;
  if (element.rowKey && element.rowKey.length > 0) {
    const { nth: _position, ...withoutPosition } = target;
    target = {
      ...withoutPosition,
      row: Object.fromEntries(element.rowKey.map((entry) => [entry.column, entry.value])),
    };
    ambiguous = false;
    reasons.push(
      `TABLE_ROW: row identified by ${element.rowKey.map((entry) => `${entry.column}=${entry.value}`).join(', ')} (never its position)`,
    );
  }
  return {
    target,
    quality: chosen.quality,
    fingerprint,
    label: humanName ?? element.componentTag ?? element.tag,
    named: humanName !== undefined,
    alternatives: candidates
      .filter((candidate) => candidate !== chosen && candidate.unique)
      .map((candidate) => ({ target: candidate.target, quality: candidate.quality })),
    ambiguous,
    reasons,
  };
}

/** Le CSS préféré et le repli structurel d'un élément, tels qu'enregistrés (jamais une identité seule). */
function cssRecordOf(element: RecordedElement): Pick<TargetFingerprint, 'css'> {
  const selectors = element.selectors;
  if (!selectors) return {};
  const preferred =
    selectors.preferred && !selectors.preferred.structural && !selectors.preferred.dynamic
      ? selectors.preferred
      : undefined;
  const fallback =
    selectors.structural.selector !== preferred?.selector && selectors.structural.matchCount > 0
      ? selectors.structural
      : undefined;
  if (!preferred && !fallback) return {};
  const record = (candidate: { selector: string; matchCount: number; confidence: number }) => ({
    selector: candidate.selector,
    matchCount: candidate.matchCount,
    confidence: candidate.confidence,
  });
  return {
    css: {
      ...(preferred ? { preferred: record(preferred) } : {}),
      ...(fallback ? { fallback: record(fallback) } : {}),
    },
  };
}

/** AMBIGUITY SCORE : le niveau connu à l'enregistrement, avec les libellés répétés. */
function ambiguityRecordOf(element: RecordedElement): Pick<TargetFingerprint, 'ambiguity'> {
  const known = element.selectors?.ambiguity;
  const reasons = [...(known?.reasons ?? [])];
  if (element.sameLabel > 1 && !reasons.includes('REPEATED_LABEL')) reasons.push('REPEATED_LABEL');
  if (!known && reasons.length === 0) return {};
  const level = known?.level ?? 'LOW';
  return { ambiguity: { level: level === 'NONE' && reasons.length > 0 ? 'LOW' : level, reasons } };
}

/** « general.priorite » : la section la plus proche et le nom humain, en identifiant stable. */
export function semanticIdOf(section: string | undefined, name: string | undefined): string | undefined {
  const slug = (text: string): string =>
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  if (!name || !readable(name)) return undefined;
  const scope = section?.split('>').at(-1)?.trim();
  const id = [scope ? slug(scope) : '', slug(name)].filter(Boolean).join('.');
  return id || undefined;
}

/**
 * Le rang d'un localisateur, à la manière de Playwright (1 = le meilleur) : test id, rôle + nom,
 * libellé, placeholder, texte, attribut stable, CSS stable, position.
 */
function rankOf(candidate: { target: FlowTarget; quality: LocatorQuality }): number {
  const { target } = candidate;
  if (target.strategy === 'testId') return LOCATOR_PRIORITY.testId;
  if (target.strategy === 'role') return LOCATOR_PRIORITY.role;
  if (target.strategy === 'label') return LOCATOR_PRIORITY.label;
  if (target.strategy === 'text') return LOCATOR_PRIORITY.text;
  if ((target.value ?? '').startsWith('[placeholder=')) return LOCATOR_PRIORITY.placeholder;
  if (candidate.quality === 'STABLE_ATTRIBUTE' || candidate.quality === 'FRAMEWORK_BINDING') return 7;
  if (candidate.quality === 'CSS_STABLE') return LOCATOR_PRIORITY.css;
  return 10;
}
