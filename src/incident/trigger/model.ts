import type { ElementState, TriggerAction, UiSnapshot } from '../../sdk/core/incident-trigger-contracts.js';

/**
 * LE MODÈLE DE L'INTERFACE : ce qu'un instantané permet de faire (boutons, champs, listes, cases, onglets,
 * dialogues), classé en sondes (actions dont la réaction est vérifiée), actions préparatoires (états, données,
 * temps) et actions jamais jouées d'office (destructives : proposées à une personne). Les valeurs de données
 * (vides, limites, spéciales, valides) sont générées ici, sans jamais inventer une valeur sensible.
 */
export type FactorDimension = 'ACTIONS' | 'DATA' | 'STATES' | 'TIMING';

export interface Factor {
  id: string;
  dimension: FactorDimension;
  label: string;
  actions: TriggerAction[];
  /** La cible concernée (champ, bouton), pour éviter deux facteurs incompatibles sur la même cible. */
  target?: string;
  /** Priorité initiale (plus grand = plus tôt), ajustée par les stratégies. */
  priority: number;
  origin: 'MODEL' | 'CODE' | 'ERROR' | 'AI' | 'SCENARIO';
}

/** Une action issue d'un facteur exploré (ni la navigation ni les remplissages de référence, ni une sonde). */
export const isFactorAction = (action: TriggerAction): boolean =>
  action.origin !== undefined && action.origin !== 'probe' && action.origin !== 'reference';

export interface ActionCatalog {
  /** Les sondes, la principale d'abord (bouton de soumission). */
  probes: TriggerAction[];
  /** Les remplissages valides des champs (le parcours de référence). */
  fills: TriggerAction[];
  factors: Factor[];
  /** Les actions destructives reconnues, jamais jouées sans une personne. */
  destructive: TriggerAction[];
  fields: ElementState[];
}

export const SUBMIT_WORDS =
  /(enregistr|sauvegard|valider|soumettre|envoyer|confirmer|cr[ée]er|ajouter|save|submit|send|confirm|create|add|apply|rechercher|search|calculer|compute)/i;
export const DESTRUCTIVE_WORDS =
  /(supprim|effacer tout|delete|remove|purger|purge|r[ée]initialiser|reset|d[ée]connect|logout|sign out|archiver|archive|cl[oô]tur|close account|payer|pay\b|virement|transfer)/i;
export const DIALOG_OPEN_WORDS =
  /(notes?|d[ée]tails?|commentaire|comment|aide|help|options?|param[èe]tres?|settings|ouvrir|open|modifier|edit|ajouter|add|historique|history|aper[çc]u|preview|pi[èe]ces? jointes?|attachments?|s[ée]lectionner|choose|pick)/i;
export const DIALOG_CLOSE_WORDS = /^(fermer|close|annuler|cancel|ok|retour|back|terminer|done|×|x)$/i;
export const REFRESH_WORDS = /(rafra[iî]ch|refresh|recharger|reload|actualiser|charger|load|trier|sort)/i;

const LONG_TEXT = 'x'.repeat(256);
const SPECIAL_TEXT = `<b>test</b> & "quote" 'apos' \\ %`;
const UNICODE_TEXT = 'Élodie Žužana 日本語 😀';
const MAX_FACTORS = 120;

const isNumeric = (value: string | undefined): boolean =>
  value !== undefined && /^-?\d+([.,]\d+)?$/.test(value.trim());
const isDate = (value: string | undefined): boolean =>
  value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value.trim());

/** Une valeur valide pour un champ : la valeur présente, sinon une valeur plausible d'après le libellé. */
export function validValueFor(field: ElementState): string {
  if (field.value && field.value.trim() !== '' && field.value !== 'false') return field.value;
  const name = field.name.toLowerCase();
  if (/mail/.test(name)) return 'test.qa@example.test';
  if (/t[ée]l|phone/.test(name)) return '5145550199';
  if (/date/.test(name)) return '2026-01-15';
  if (/code|num[ée]ro|number|id\b|isbn|r[ée]f/.test(name)) return 'A1234';
  if (/montant|amount|prix|price|quantit|qty|total|nombre|count/.test(name)) return '10';
  if (/url|lien|link/.test(name)) return 'https://example.test/';
  return `Valeur ${field.name || 'test'}`.slice(0, 40);
}

/** Les valeurs limites et spéciales d'un champ (dimension DATA). */
export function boundaryValues(field: ElementState): { label: string; value: string }[] {
  const current = field.value;
  const out: { label: string; value: string }[] = [
    { label: 'espaces seulement', value: '   ' },
    { label: 'texte long (256)', value: LONG_TEXT },
    { label: 'caractères spéciaux', value: SPECIAL_TEXT },
  ];
  if (
    isNumeric(current) ||
    /montant|amount|prix|price|quantit|qty|total|nombre|count|num[ée]ro|number/i.test(field.name)
  )
    out.push(
      { label: 'zéro', value: '0' },
      { label: 'négatif', value: '-1' },
      { label: 'très grand', value: '999999999999' },
      { label: 'décimal', value: '1,5' },
    );
  else out.push({ label: 'unicode', value: UNICODE_TEXT });
  if (isDate(current) || /date/i.test(field.name))
    out.push({ label: 'date invalide', value: '2026-02-31' }, { label: 'date passée', value: '1900-01-01' });
  return out;
}

const target = (element: ElementState): string =>
  `${element.role === 'textbox' || element.role === 'combobox' || element.role === 'checkbox' ? 'label' : element.role}:${element.name}`;

/** Le catalogue d'actions d'un écran, à partir de son instantané ; `scenarioFills` : les saisies du scénario connu. */
export function buildCatalog(
  snapshot: UiSnapshot,
  options: { scenarioFills?: TriggerAction[]; keywords?: string[] } = {},
): ActionCatalog {
  const visible = snapshot.elements.filter((element) => element.visible && element.name.trim() !== '');
  const buttons = visible.filter((element) => element.role === 'button');
  const fields = visible.filter(
    (element) => element.role === 'textbox' || element.role === 'combobox' || element.role === 'checkbox',
  );
  const tabs = visible.filter((element) => element.role === 'tab');
  const links = visible.filter((element) => element.role === 'link');
  const keywords = (options.keywords ?? []).map((word) => word.toLowerCase());
  const mentions = (name: string): boolean => keywords.some((word) => name.toLowerCase().includes(word));

  const destructive: TriggerAction[] = buttons
    .filter((button) => DESTRUCTIVE_WORDS.test(button.name))
    .map((button) => ({ kind: 'CLICK', target: target(button) }));
  const safeButtons = buttons.filter((button) => !DESTRUCTIVE_WORDS.test(button.name) && button.enabled);
  const submit = safeButtons
    .filter((button) => SUBMIT_WORDS.test(button.name))
    .sort((a, b) => Number(mentions(b.name)) - Number(mentions(a.name)));
  const refresh = safeButtons.filter((button) => REFRESH_WORDS.test(button.name) && !submit.includes(button));
  const probes: TriggerAction[] = [...submit, ...refresh].map((button) => ({
    kind: 'CLICK',
    target: target(button),
    origin: 'MODEL',
  }));

  const scenarioFills = options.scenarioFills ?? [];
  const fills: TriggerAction[] = fields
    .filter((field) => field.role !== 'checkbox')
    .map((field): TriggerAction | undefined => {
      const known = scenarioFills.find((fill) => fill.target === target(field));
      if (known) return { ...known, origin: 'SCENARIO' };
      if (field.role === 'combobox') {
        const option = field.options?.find(
          (label) => label.trim() !== '' && !/^(--|choisir|select|sélectionner)/i.test(label),
        );
        return option ? { kind: 'SELECT', target: target(field), value: option, origin: 'MODEL' } : undefined;
      }
      return { kind: 'FILL', target: target(field), value: validValueFor(field), origin: 'MODEL' };
    })
    .filter((fill): fill is TriggerAction => fill !== undefined);

  const factors: Factor[] = [];
  const add = (factor: Factor): void => {
    if (factors.length < MAX_FACTORS && !factors.some((item) => item.id === factor.id)) factors.push(factor);
  };
  // Données : vider chaque champ ; valeurs limites.
  for (const field of fields) {
    const key = target(field);
    const boost = mentions(field.name) ? 2 : 0;
    if (field.role === 'checkbox') {
      add({
        id: `data:check:${key}`,
        dimension: 'DATA',
        label: `cocher ${field.name}`,
        actions: [{ kind: 'CHECK', target: key, value: 'true' }],
        target: key,
        priority: 3 + boost,
        origin: 'MODEL',
      });
      add({
        id: `data:uncheck:${key}`,
        dimension: 'DATA',
        label: `décocher ${field.name}`,
        actions: [{ kind: 'CHECK', target: key, value: 'false' }],
        target: key,
        priority: 3 + boost,
        origin: 'MODEL',
      });
      continue;
    }
    if (field.role === 'combobox') {
      for (const option of (field.options ?? []).slice(0, 6))
        add({
          id: `data:select:${key}=${option}`,
          dimension: 'DATA',
          label: `${field.name} = ${option}`,
          actions: [{ kind: 'SELECT', target: key, value: option }],
          target: key,
          priority: 3 + boost,
          origin: 'MODEL',
        });
      continue;
    }
    add({
      id: `data:empty:${key}`,
      dimension: 'DATA',
      label: `${field.name} vide`,
      actions: [{ kind: 'CLEAR', target: key }],
      target: key,
      priority: 6 + boost,
      origin: 'MODEL',
    });
    for (const boundary of boundaryValues(field))
      add({
        id: `data:${boundary.label}:${key}`,
        dimension: 'DATA',
        label: `${field.name} : ${boundary.label}`,
        actions: [{ kind: 'FILL', target: key, value: boundary.value }],
        target: key,
        priority: 2 + boost,
        origin: 'MODEL',
      });
    add({
      id: `data:modify:${key}`,
      dimension: 'DATA',
      label: `${field.name} modifié puis vidé`,
      actions: [
        { kind: 'FILL', target: key, value: validValueFor(field) },
        { kind: 'CLEAR', target: key },
      ],
      target: key,
      priority: 4 + boost,
      origin: 'MODEL',
    });
  }
  // États : dialogues ouverts puis fermés, onglets, retour arrière, navigation.
  for (const button of safeButtons.filter((item) => !submit.includes(item) && !refresh.includes(item))) {
    const key = target(button);
    const closer = safeButtons.find((item) => DIALOG_CLOSE_WORDS.test(item.name.trim()));
    const opensDialog = DIALOG_OPEN_WORDS.test(button.name) || !closer;
    const boost = mentions(button.name) ? 2 : 0;
    add({
      id: `state:dialog:${key}`,
      dimension: 'STATES',
      label: `ouvrir puis fermer « ${button.name} »`,
      actions: [{ kind: 'OPEN_DIALOG', target: key }, { kind: 'CLOSE_DIALOG' }],
      target: key,
      priority: (opensDialog ? 6 : 4) + boost,
      origin: 'MODEL',
    });
    add({
      id: `action:click:${key}`,
      dimension: 'ACTIONS',
      label: `cliquer « ${button.name} »`,
      actions: [{ kind: 'CLICK', target: key }],
      target: key,
      priority: 3 + boost,
      origin: 'MODEL',
    });
  }
  for (const tab of tabs) {
    const key = target(tab);
    const first = tabs[0];
    add({
      id: `state:tab:${key}`,
      dimension: 'STATES',
      label: `onglet « ${tab.name} » puis retour`,
      actions:
        first && first !== tab
          ? [
              { kind: 'TAB', target: key },
              { kind: 'TAB', target: target(first) },
            ]
          : [{ kind: 'TAB', target: key }],
      target: key,
      priority: 5 + (mentions(tab.name) ? 2 : 0),
      origin: 'MODEL',
    });
  }
  for (const link of links.slice(0, 6)) {
    const key = target(link);
    add({
      id: `state:away:${key}`,
      dimension: 'STATES',
      label: `aller « ${link.name} » puis revenir`,
      actions: [{ kind: 'CLICK', target: key }, { kind: 'BACK' }],
      target: key,
      priority: 3,
      origin: 'MODEL',
    });
  }
  // Temps : double clic sur la sonde, attente, soumission répétée.
  const mainProbe = probes[0];
  if (mainProbe) {
    add({
      id: 'timing:double',
      dimension: 'TIMING',
      label: 'double clic sur la sonde',
      actions: [{ kind: 'REPEAT', target: mainProbe.target ?? '', count: 2 }],
      priority: 4,
      origin: 'MODEL',
    });
    add({
      id: 'timing:wait',
      dimension: 'TIMING',
      label: 'attendre 1,5 s avant la sonde',
      actions: [{ kind: 'WAIT', count: 1500 }],
      priority: 1,
      origin: 'MODEL',
    });
    add({
      id: 'timing:submit-twice',
      dimension: 'TIMING',
      label: 'soumettre, puis soumettre encore',
      actions: [
        { kind: 'CLICK', target: mainProbe.target ?? '' },
        { kind: 'WAIT', count: 300 },
      ],
      priority: 3,
      origin: 'MODEL',
    });
  }
  return { probes, fills, factors, destructive, fields };
}

/** Le facteur d'un champ cité par le code (contrôle, validateur) : priorité relevée. */
export function boostFactors(catalog: ActionCatalog, names: readonly string[], amount = 3): void {
  const wanted = names.map((name) => name.toLowerCase());
  for (const factor of catalog.factors) {
    const label = (factor.target ?? factor.label).toLowerCase();
    if (wanted.some((name) => name && label.includes(name))) factor.priority += amount;
  }
}
