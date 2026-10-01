import type { FlowTarget } from '../config/flow-schema.js';
import type { LocatorQuality, RecordedElement, RecordedTarget } from './model.js';

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

  if (use === 'field' || use === 'check') {
    if (label)
      candidates.push({
        target: { strategy: 'label', value: label },
        quality: 'SEMANTIC',
        unique: element.sameLabel <= 1,
        why: `field label "${label}"`,
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
    const text = element.text;
    if (readable(text) && text.length <= 60 && !CLICK_ROLES.has(role))
      candidates.push({
        target: { strategy: 'text', value: text },
        quality: 'ACCESSIBLE',
        unique: element.sameRoleName <= 1,
        why: `visible text "${text}"`,
      });
  }
  if (element.testId)
    candidates.push({
      target: { strategy: 'testId', value: element.testId },
      quality: 'STABLE_ATTRIBUTE',
      unique: true,
      why: `test id "${element.testId}"`,
    });
  if (element.nameAttr && !/\d{2,}/.test(element.nameAttr))
    candidates.push({
      target: { strategy: 'css', value: `${element.tag}[name="${element.nameAttr}"]` },
      quality: 'STABLE_ATTRIBUTE',
      unique: true,
      why: `name attribute "${element.nameAttr}"`,
    });
  if (element.formControlName)
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
      unique: true,
      why: `stable id "${element.elementId}"`,
    });
  const fragile: FlowTarget = { strategy: 'css', value: element.css };
  candidates.push({
    target: fragile,
    quality: element.cssStable ? 'CSS_STABLE' : 'FRAGILE',
    unique: true,
    why: element.cssStable ? 'stable selector' : 'position in the page (fragile)',
  });

  const best = candidates.find((candidate) => candidate.unique) ?? candidates[0];
  const first = candidates[0];
  const reasons: string[] = [];
  let chosen = best ?? { target: fragile, quality: 'FRAGILE' as const, unique: true, why: 'no locator' };
  let ambiguous = false;
  // Le meilleur localisateur lisible désigne plusieurs éléments, et seul un chemin fragile reste.
  if (first && !first.unique && chosen.quality === 'FRAGILE') {
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
  return {
    target: chosen.target,
    quality: chosen.quality,
    label: label ?? name ?? element.text ?? element.formControlName ?? element.nameAttr ?? element.tag,
    alternatives: candidates
      .filter((candidate) => candidate !== chosen && candidate.unique)
      .map((candidate) => ({ target: candidate.target, quality: candidate.quality })),
    ambiguous,
    reasons,
  };
}
