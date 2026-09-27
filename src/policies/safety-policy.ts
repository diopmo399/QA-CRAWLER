import type { SafeActionGroup, ScenarioConfig } from '../config/config.js';
import type {
  ActionCategory,
  ActionClassification,
  ActionType,
  DiscoveredAction,
  RiskKind,
} from '../model/discovered-action.js';
import { KeywordMatcher, MUTATION_KEYWORDS, RISK_KEYWORDS, STEP_KEYWORDS, urlText } from './keywords.js';
import { NavigationPolicy, NON_HTML_EXTENSION } from './navigation-policy.js';
import { sensitivityOf, type FieldDescription } from './sensitive-fields.js';

/** Keeps only the defined properties (exactOptionalPropertyTypes). */
function stripUndefined(description: Record<string, string | undefined>): FieldDescription {
  return Object.fromEntries(
    Object.entries(description).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** What the policy needs to know to classify an element (a subset of a DiscoveredAction). */
export interface ClassifiableAction {
  type: ActionType;
  category: ActionCategory;
  text?: string;
  label?: string;
  name?: string;
  elementId?: string;
  href?: string;
  routerLink?: string;
  role?: string;
  inputType?: string;
  autocomplete?: string;
  placeholder?: string;
  isSubmit?: boolean;
  /** Sends the form it belongs to (inside a <form>, a dialog or an overlay with fields). */
  submitsForm?: boolean;
  inSearchForm?: boolean;
  /** The enclosing form posts to a server URL. */
  formHasAction?: boolean;
  /** Name of the dialog containing the element ("Supprimer l'utilisateur ?"). */
  dialogName?: string;
  external?: boolean;
}

export interface Classification {
  classification: ActionClassification;
  reason: string;
  risks: RiskKind[];
}

export interface SafetyVerdict {
  verdict: 'ALLOW' | 'BLOCK';
  reason: string;
}

/** Risks blocked whatever the configuration says. */
const ALWAYS_BLOCKED: readonly RiskKind[] = ['sensitive-data'];

const GROUP_OF_CATEGORY: Record<ActionCategory, SafeActionGroup | undefined> = {
  navigation: 'navigation',
  tab: 'tabs',
  menu: 'menus',
  details: 'details',
  pagination: 'pagination',
  search: 'search',
  filter: 'filter',
  'form-input': 'forms',
  'form-step': 'forms',
  toggle: 'other',
  other: 'other',
  submit: undefined,
};

/**
 * Central safety rules.
 *
 * - `classify()` tells how risky an action is (SAFE / MUTATION / DANGEROUS /
 *   UNKNOWN) and why; ActionDiscovery stores the result on each action.
 * - `evaluate()` is the gate between the decision engine and Playwright:
 *   whatever engine chose the action, it is executed only on ALLOW.
 *
 * Defaults: only SAFE actions run; DANGEROUS ones, sensitive fields,
 * external navigation, form submission, logout… are always blocked.
 */
export class SafetyPolicy {
  readonly navigation: NavigationPolicy;
  private readonly risks: [RiskKind, KeywordMatcher][];
  private readonly mutation: KeywordMatcher;
  private readonly step: KeywordMatcher;
  private readonly allowedClasses: ReadonlySet<ActionClassification>;
  private readonly allowedGroups: ReadonlySet<SafeActionGroup>;
  private readonly blocked: ReadonlySet<RiskKind>;

  constructor(safety: ScenarioConfig['safety']) {
    this.risks = Object.entries(RISK_KEYWORDS).map(([kind, words]) => [
      kind as RiskKind,
      new KeywordMatcher([...words, ...(kind === 'delete' ? safety.keywords.dangerous : [])]),
    ]);
    this.mutation = new KeywordMatcher([...MUTATION_KEYWORDS, ...safety.keywords.mutation]);
    this.step = new KeywordMatcher([...STEP_KEYWORDS, ...safety.keywords.safe]);
    this.allowedClasses = new Set(safety.allowedActionClasses);
    this.allowedGroups = new Set(safety.allow);
    this.blocked = new Set([...safety.block, ...ALWAYS_BLOCKED]);
    this.navigation = new NavigationPolicy(safety, this);
  }

  classify(action: ClassifiableAction): Classification {
    const label = [action.text, action.label, action.name, action.elementId].filter(Boolean).join(' ');
    const target = action.href ? urlText(action.href) : '';
    const router = action.routerLink ?? '';

    if (isFieldAction(action.type)) {
      const sensitivity = sensitivityOf({
        ...(action.inputType !== undefined ? { inputType: action.inputType } : {}),
        ...(action.autocomplete !== undefined ? { autocomplete: action.autocomplete } : {}),
        label,
        ...(action.placeholder !== undefined ? { placeholder: action.placeholder } : {}),
      });
      if (sensitivity.sensitive) {
        return {
          classification: 'DANGEROUS',
          reason: 'sensitive field (password, payment or secret data): never filled',
          // Payment data also triggers the payment risk (blocked by default).
          risks: sensitivity.payment ? ['sensitive-data', 'payment'] : ['sensitive-data'],
        };
      }
      return { classification: 'SAFE', reason: 'fills a field locally (nothing is sent)', risks: [] };
    }

    const risks: RiskKind[] = [];
    let firstMatch: string | undefined;
    for (const [kind, matcher] of this.risks) {
      const match = matcher.match(label, target, router, action.dialogName);
      if (match) {
        risks.push(kind);
        firstMatch ??= match;
      }
    }
    if (firstMatch !== undefined) {
      if (action.external) risks.push('external-navigation');
      return { classification: 'DANGEROUS', reason: `matches dangerous keyword "${firstMatch}"`, risks };
    }
    if (action.external) {
      return { classification: 'SAFE', reason: 'link to another site', risks: ['external-navigation'] };
    }
    if (action.type === 'navigate') {
      if (action.href && isDownload(action.href)) {
        return { classification: 'SAFE', reason: 'file download, not a screen', risks: ['download'] };
      }
      return { classification: 'SAFE', reason: 'navigation (GET, no data change)', risks: [] };
    }

    // click: buttons, tabs, menus, routerLink elements…
    const stepWord = this.step.match(label);
    if ((action.isSubmit || action.submitsForm) && !action.inSearchForm) {
      if (stepWord && !action.formHasAction) {
        return { classification: 'SAFE', reason: `wizard step "${stepWord}" (client-side form)`, risks: [] };
      }
      return { classification: 'MUTATION', reason: 'submits a form', risks: ['form-submit'] };
    }
    const mutation = this.mutation.match(label, router);
    if (mutation) {
      return {
        classification: 'MUTATION',
        reason: `matches mutation keyword "${mutation}"`,
        risks: ['mutation'],
      };
    }
    if (action.isSubmit && action.inSearchForm) {
      return { classification: 'SAFE', reason: 'submits a search form', risks: [] };
    }
    // Symbols and icons ("⚙", "×", "…") say nothing about what the control does.
    if (!/[\p{L}\p{N}]{2,}/u.test(label)) {
      return {
        classification: 'UNKNOWN',
        reason: 'no readable label (icon or symbol only): never executed automatically',
        risks: [],
      };
    }
    return {
      classification: 'SAFE',
      reason: `in-page control (${action.category}), no risky keyword`,
      risks: [],
    };
  }

  /** Classifies a URL the explorer may navigate to (e.g. /users/3/delete). */
  classifyUrl(url: string): Classification {
    for (const [kind, matcher] of this.risks) {
      const match = matcher.match(urlText(url));
      if (match) {
        return {
          classification: 'DANGEROUS',
          reason: `URL matches dangerous keyword "${match}"`,
          risks: [kind],
        };
      }
    }
    return { classification: 'SAFE', reason: 'plain navigation', risks: [] };
  }

  /**
   * Final gate before execution. Runs after the decision engine and before
   * Playwright, so no engine can bypass it.
   */
  evaluate(action: DiscoveredAction): SafetyVerdict {
    if (action.disabled) return { verdict: 'BLOCK', reason: 'element is disabled' };
    if (!action.visible) return { verdict: 'BLOCK', reason: 'element is not visible' };

    const blockedRisk = action.risks.find((risk) => this.blocked.has(risk));
    if (blockedRisk) return { verdict: 'BLOCK', reason: `risk "${blockedRisk}" is blocked by the mission` };

    if (action.href && (action.type === 'navigate' || action.external === true)) {
      let url: URL;
      try {
        url = new URL(action.href);
      } catch {
        return { verdict: 'BLOCK', reason: 'invalid link target' };
      }
      const decision = this.navigation.evaluate(url);
      if (!decision.allowed) {
        return { verdict: 'BLOCK', reason: `navigation refused: ${decision.reason} (${decision.detail})` };
      }
    }

    if (!this.allowedClasses.has(action.classification)) {
      return {
        verdict: 'BLOCK',
        reason: `${action.classification} actions are not allowed (${action.reason})`,
      };
    }
    if (action.classification === 'SAFE') {
      const group = GROUP_OF_CATEGORY[action.category];
      if (group && !this.allowedGroups.has(group)) {
        return { verdict: 'BLOCK', reason: `the mission does not allow "${group}" actions` };
      }
    }
    return { verdict: 'ALLOW', reason: action.reason };
  }

  /** Card, IBAN… fields: never filled, whatever the source of the value. */
  isPaymentField(action: DiscoveredAction): boolean {
    const field = action.field;
    return [
      {
        autocomplete: field?.autocomplete,
        name: field?.name,
        label: field?.label,
        placeholder: field?.placeholder,
      },
      { name: action.name, label: action.label ?? action.text },
    ].some((description) => sensitivityOf(stripUndefined(description)).payment);
  }

  /** Whether an action class may run at all (used to pre-filter candidates). */
  isExecutionAllowed(classification: ActionClassification): boolean {
    return this.allowedClasses.has(classification);
  }
}

function isDownload(href: string): boolean {
  try {
    return NON_HTML_EXTENSION.test(new URL(href).pathname);
  } catch {
    return false;
  }
}

function isFieldAction(type: ActionType): boolean {
  return type === 'fill' || type === 'select' || type === 'check' || type === 'uncheck';
}
