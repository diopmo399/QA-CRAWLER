import { actionLabel, type DiscoveredAction } from '../model/discovered-action.js';
import type { PageContext } from '../model/page-context.js';
import { urlText } from '../policies/keywords.js';
import { SemanticDictionary } from '../semantics/semantic-dictionary.js';
import type { DetectedPattern, UiPattern } from './ui-pattern.js';

/** « Quels motifs d'interface cet écran montre-t-il ? » */
export interface PatternDetector {
  detect(context: PageContext): DetectedPattern[];
}

/** Un signal observé : structurel (DOM, ARIA, champs) ou textuel (libellés, titres). */
interface Signal {
  evidence: string;
  structural: boolean;
}

const ERROR_TITLE =
  /\b(404|403|401|500|502|503|not found|page not found|introuvable|forbidden|interdit|access denied|acces refuse|unauthori[sz]ed|non autorise|server error|erreur serveur|something went wrong|une erreur est survenue|erreur \d{3}|error \d{3})\b/i;
const LOGIN_WORDS =
  /\b(login|log in|sign in|signin|connexion|se connecter|authentification|authentication)\b/i;
const EDIT_ROUTE = /\/(edit|modifier|update)(\/|$)|\/:[a-z]+\/(edit|modifier)/i;
const CREATE_ROUTE = /\/(new|create|add|nouveau|nouvelle|creer|ajouter)(\/|$)/i;

/**
 * Reconnaît les motifs d'interface par règles, en combinant plusieurs signaux
 * indépendants : un tableau ET un bouton « Ajouter » ET une pagination font une
 * CRUD_LIST, pas un bouton seul. Règle d'or : le texte d'un bouton n'est jamais une
 * preuve suffisante ; chaque motif exige au moins un signal structurel (tableau,
 * champ, rôle ARIA, fenêtre, route…). La confiance grandit avec le nombre de signaux.
 */
export class RuleBasedPatternDetector implements PatternDetector {
  constructor(private readonly dictionary = new SemanticDictionary()) {}

  detect(context: PageContext): DetectedPattern[] {
    const facts = this.factsOf(context);
    const found: DetectedPattern[] = [];
    const judge = (type: UiPattern, signals: readonly (Signal | undefined)[], minimum = 2): void => {
      const observed = signals.filter((signal): signal is Signal => signal !== undefined);
      if (observed.length < minimum || !observed.some((signal) => signal.structural)) return;
      found.push({
        type,
        confidence: Math.min(0.95, Math.round((0.35 + 0.15 * observed.length) * 100) / 100),
        evidence: observed.map((signal) => signal.evidence),
      });
    };
    const s = (condition: unknown, evidence: string): Signal | undefined =>
      condition ? { evidence, structural: true } : undefined;
    const t = (condition: unknown, evidence: string): Signal | undefined =>
      condition ? { evidence, structural: false } : undefined;
    const { structure } = context;
    const title = [context.title, ...context.headings.slice(0, 3)].join(' ');

    // ---- page d'erreur : un titre d'erreur et presque rien à faire
    judge(
      'ERROR_PAGE',
      [
        t(ERROR_TITLE.test(title), `title "${clip(title)}"`),
        s(facts.clickables.length <= 5, `${facts.clickables.length} control(s) only`),
        s(facts.fields.length === 0, 'no form field'),
        s(facts.documentError, `document answered ${facts.documentError ?? ''}`),
      ],
      3,
    );

    // ---- connexion : un mot de passe, un identifiant, un bouton de connexion
    judge(
      'LOGIN',
      [
        s(facts.password, 'password field'),
        s(facts.identifier, 'username / e-mail field'),
        t(
          this.button(facts, 'login') ?? (LOGIN_WORDS.test(title) || LOGIN_WORDS.test(context.url)),
          'sign-in wording',
        ),
      ],
      2,
    );

    // ---- liste d'enregistrements
    const collection =
      (structure?.tables ?? 0) > 0 || (structure?.lists ?? 0) > 0 || (structure?.cards ?? 0) >= 3;
    const create = this.button(facts, 'create');
    judge(
      'CRUD_LIST',
      [
        s(collection, collectionEvidence(context)),
        s((structure?.tableRows ?? 0) > 0, `${structure?.tableRows ?? 0} row(s)`),
        s(facts.rowActions >= 2, `${facts.rowActions} per-row actions`),
        create ? { evidence: `button "${clip(create)}" (create)`, structural: false } : undefined,
        s(facts.search || structure?.pagination, 'search or pagination around the list'),
      ],
      3,
    );

    // ---- formulaires de création / modification
    if (facts.fields.length > 0) {
      const filled = facts.fields.filter((field) => field.field?.hasValue).length;
      const mostlyFilled = filled > 0 && filled >= facts.fields.length / 2;
      const createWords =
        this.dictionary.match('create', title, context.dialogs.join(' ')) ??
        (CREATE_ROUTE.test(context.url) ? 'url' : undefined);
      const editWords =
        this.dictionary.match('edit', title, context.dialogs.join(' ')) ??
        (EDIT_ROUTE.test(context.route) ? 'url' : undefined);
      const save = this.button(facts, 'save') ?? this.button(facts, 'create');
      judge(
        'CREATE_FORM',
        [
          s(facts.fields.length > 0 && !mostlyFilled, `${facts.fields.length} empty field(s)`),
          t(createWords, `create wording (${createWords ?? ''})`),
          t(save, `button "${clip(save ?? '')}"`),
          s(facts.submits > 0, 'submit button'),
        ],
        3,
      );
      judge(
        'EDIT_FORM',
        [
          s(mostlyFilled, `${filled}/${facts.fields.length} field(s) already filled`),
          t(editWords, `edit wording (${editWords ?? ''})`),
          s(/:[a-z]+/i.test(context.route), `record route ${context.route}`),
          t(save, `button "${clip(save ?? '')}"`),
        ],
        3,
      );
    }

    // ---- fiche d'un enregistrement
    judge(
      'DETAIL',
      [
        s(/:[a-z]+/i.test(context.route), `record route ${context.route}`),
        s(!collection || (structure?.tableRows ?? 0) <= 1, 'no record list'),
        t(this.button(facts, 'edit'), 'edit button'),
        s(
          (structure?.breadcrumbs.length ?? 0) >= 2,
          `breadcrumb ${structure?.breadcrumbs.join(' › ') ?? ''}`,
        ),
        t(this.button(facts, 'previous'), 'back button'),
      ],
      3,
    );

    judge(
      'SEARCH',
      [
        s(facts.search, 'search field'),
        t(this.button(facts, 'search'), 'search button'),
        s(collection, 'results list'),
      ],
      2,
    );
    judge(
      'FILTER',
      [
        s(facts.filters > 0, `${facts.filters} filter control(s)`),
        s(collection, 'filtered list'),
        t(this.dictionary.match('filter', title), 'filter wording'),
      ],
      2,
    );
    judge(
      'PAGINATION',
      [
        s(structure?.pagination, 'pagination bar'),
        s(facts.pagination > 0, `${facts.pagination} pagination control(s)`),
        s(collection, 'paged list'),
      ],
      2,
    );
    judge(
      'WIZARD',
      [
        s((structure?.wizardSteps ?? 0) >= 2, `${structure?.wizardSteps ?? 0} steps`),
        s(facts.steps > 0, 'next / previous step controls'),
        t(this.button(facts, 'next'), 'next button'),
        s(facts.fields.length > 0, 'fields in the step'),
      ],
      2,
    );

    // ---- fenêtre de confirmation : une fenêtre, peu de champs, confirmer + annuler
    judge(
      'CONFIRMATION_DIALOG',
      [
        s(context.dialogs.length > 0, `dialog "${clip(context.dialogs[0] ?? '')}"`),
        s(facts.fields.filter((field) => field.foreground).length === 0, 'no field in the dialog'),
        t(
          this.button(facts, 'confirm', true) ?? this.button(facts, 'delete', true),
          'confirm button in the dialog',
        ),
        t(this.button(facts, 'cancel', true), 'cancel button in the dialog'),
      ],
      3,
    );

    judge(
      'EMPTY_STATE',
      [
        s(structure?.emptyMessage, `"${clip(structure?.emptyMessage ?? '')}"`),
        s((structure?.tables ?? 0) > 0 && structure?.tableRows === 0, 'table without rows'),
        s(facts.clickables.length > 0, 'screen still usable'),
      ],
      2,
    );
    judge(
      'DASHBOARD',
      [
        s((structure?.cards ?? 0) >= 3, `${structure?.cards ?? 0} cards`),
        s((structure?.regions.length ?? 0) >= 2, `${structure?.regions.length ?? 0} named regions`),
        s(facts.menu >= 3, `${facts.menu} menu entries`),
        t(this.dictionary.match('home', title, urlText(context.url)), 'dashboard / home wording'),
      ],
      2,
    );
    judge(
      'MASTER_DETAIL',
      [
        s(collection, 'list of records'),
        s(
          facts.fields.some((field) => field.field?.hasValue) || (structure?.regions.length ?? 0) >= 2,
          'detail pane',
        ),
        s(facts.selectedRow, 'selected item'),
      ],
      3,
    );
    judge('TABS', [s(facts.tabs >= 2, `${facts.tabs} tabs`), s(facts.tabs >= 2, 'tablist')], 2);
    judge('MENU', [s(facts.menu >= 3, `${facts.menu} menu entries`), s(facts.menu >= 3, 'navigation')], 2);
    judge(
      'UPLOAD',
      [
        s((structure?.fileInputs ?? 0) > 0, 'file input / drop zone'),
        t(this.button(facts, 'upload'), 'upload button'),
      ],
      1,
    );

    return found.sort((a, b) => b.confidence - a.confidence);
  }

  /** Le libellé du premier bouton / lien qui porte ce concept (dans la fenêtre seulement si `inDialog`). */
  private button(facts: Facts, concept: string, inDialog = false): string | undefined {
    for (const action of facts.clickables) {
      if (inDialog && !action.foreground) continue;
      const label = actionLabel(action);
      if (this.dictionary.match(concept, label, action.href ? urlText(action.href) : undefined)) return label;
    }
    return undefined;
  }

  private factsOf(context: PageContext): Facts {
    const clickables = context.actions.filter(
      (action) => action.type === 'click' || action.type === 'navigate',
    );
    const fields = context.actions.filter(
      (action) => action.type === 'fill' || action.type === 'select' || action.type === 'check',
    );
    const rowLabels = new Map<string, number>();
    for (const action of clickables) {
      if (action.category !== 'details' && action.category !== 'navigation') continue;
      const key = actionLabel(action).toLowerCase().replace(/\d+/g, '#');
      rowLabels.set(key, (rowLabels.get(key) ?? 0) + 1);
    }
    const documentError = context.errors.find(
      (issue) =>
        (issue.type === 'HTTP' || issue.type === 'BROKEN_LINK') &&
        issue.requestUrl === context.url &&
        (issue.status ?? 0) >= 400,
    );
    return {
      clickables,
      fields,
      password: fields.some((action) => action.field?.inputType === 'password'),
      identifier: fields.some(
        (action) =>
          action.field?.inputType === 'email' ||
          /user|login|identifiant|e-?mail|courriel/i.test(
            `${action.field?.name ?? ''} ${action.label ?? ''}`,
          ),
      ),
      search: context.actions.some(
        (action) =>
          (action.category === 'search' && action.type !== 'click') ||
          action.role === 'searchbox' ||
          action.field?.inputType === 'search',
      ),
      filters: context.actions.filter((action) => action.category === 'filter').length,
      pagination: context.actions.filter((action) => action.category === 'pagination').length,
      steps: context.actions.filter((action) => action.category === 'form-step').length,
      tabs: context.actions.filter((action) => action.category === 'tab').length,
      menu: context.actions.filter((action) => action.category === 'menu').length,
      submits: context.actions.filter((action) => action.submitsForm || action.category === 'submit').length,
      rowActions: Math.max(0, ...rowLabels.values()),
      selectedRow: context.actions.some((action) => action.selected === true && action.category !== 'tab'),
      ...(documentError?.status !== undefined ? { documentError: documentError.status } : {}),
    };
  }
}

interface Facts {
  clickables: DiscoveredAction[];
  fields: DiscoveredAction[];
  password: boolean;
  identifier: boolean;
  search: boolean;
  filters: number;
  pagination: number;
  steps: number;
  tabs: number;
  menu: number;
  submits: number;
  /** Le plus grand nombre de liens de même libellé (« Voir » sur chaque ligne). */
  rowActions: number;
  selectedRow: boolean;
  documentError?: number;
}

function collectionEvidence(context: PageContext): string {
  const structure = context.structure;
  if (!structure) return 'collection';
  if (structure.tables > 0)
    return `table${structure.columnHeaders.length > 0 ? ` (${structure.columnHeaders.slice(0, 4).join(', ')})` : ''}`;
  if (structure.lists > 0) return `${structure.lists} list(s)`;
  return `${structure.cards} cards`;
}

function clip(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Le motif le plus sûr d'un type donné, s'il a été détecté. */
export function patternOf(
  patterns: readonly DetectedPattern[],
  type: UiPattern,
): DetectedPattern | undefined {
  return patterns.find((pattern) => pattern.type === type);
}
