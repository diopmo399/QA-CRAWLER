import type {
  AuthDraft,
  Capabilities,
  ExplorationCounters,
  ExplorationEvent,
  ExplorationSnapshot,
  ExplorationSummary,
  Project,
  ProjectDraft,
  UrlCheck,
  ValidationReport,
} from '../core/contracts.js';
import { ENV_NAME_PATTERN } from '../core/contracts.js';
import type { Strings } from './i18n.js';

/**
 * LE RENDU DE L'ASSISTANT : des fonctions pures (état → HTML), sans DOM, testables sous Node.
 * Tout texte venu du serveur ou de l'utilisateur passe par `esc`.
 */

export type StepNumber = 1 | 2 | 3 | 4 | 5;

export interface MapNode {
  id: string;
  label: string;
  route: string;
}

export interface RunState {
  snapshot: ExplorationSnapshot;
  counters: ExplorationCounters;
  events: ExplorationEvent[];
  nodes: MapNode[];
  edges: { from: string; to: string }[];
  /** Début (horloge du client, corrigée de l'écart avec le serveur). */
  startedAtMs?: number;
  finishedAtMs?: number;
  now: number;
  summary?: ExplorationSummary;
  error?: string;
}

export interface WizardState {
  t: Strings;
  locale: 'fr' | 'en';
  mode: 'standalone' | 'embedded';
  productName?: string;
  logo?: string;
  phase: 'loading' | 'error' | 'ready';
  loadError?: string;
  caps?: Capabilities;
  step: StepNumber;
  visited: StepNumber;
  draft: ProjectDraft;
  showErrors: Partial<Record<StepNumber, boolean>>;
  urlCheck?: UrlCheck;
  urlChecking: boolean;
  env: Record<string, boolean>;
  validation?: ValidationReport;
  validating: boolean;
  project?: Project;
  busy: boolean;
  actionError?: string;
  run?: RunState;
  pending: { host: string; path: string };
}

export function esc(value: string | number | boolean | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ICONS: Record<string, string> = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 3l9.5 17H2.5z"/><path d="M12 10v4M12 17.5v.5"/>',
  stop: '<circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowL: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  atom: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>',
  vee: '<path d="M3 5h4l5 9 5-9h4l-9 15z"/>',
  cloud: '<path d="M7 18h10.5a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 7.3 9.6 4.2 4.2 0 0 0 7 18z"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  route:
    '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a4 4 0 000-8h-4a4 4 0 010-8h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  text: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
};

export function icon(name: string, extra = ''): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${ICONS[name] ?? ''}</svg>`;
}

// ————————————————————————————————————————————— validation locale (format seulement)

/** Les erreurs de format d'une étape (la validation qui fait foi est celle du serveur, au récapitulatif). */
export function stepErrors(draft: ProjectDraft, step: StepNumber, t: Strings): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 1) {
    if (!draft.project.name.trim()) errors['project.name'] = t.required;
    if (!/^https?:\/\/[^\s/]+/i.test(draft.project.targetUrl.trim()))
      errors['project.targetUrl'] = t.s1.formatBad;
  }
  if (step === 2) {
    const auth = draft.environment.auth;
    const need = (field: string, value: string | undefined): void => {
      if (!value || !value.trim()) errors[`environment.auth.${field}`] = t.required;
    };
    if (auth.type !== 'none') {
      for (const field of ['usernameEnv', 'passwordEnv'] as const)
        if (!ENV_NAME_PATTERN.test(auth[field])) errors[`environment.auth.${field}`] = t.s2.envBad;
    }
    if (auth.type === 'form') {
      need('loginUrl', auth.loginUrl);
      need('usernameSelector', auth.usernameSelector);
      need('passwordSelector', auth.passwordSelector);
      need('submitSelector', auth.submitSelector);
    }
    if (auth.type === 'sso') {
      if (!/^https?:\/\/[^\s/]+/i.test(auth.identityProviderOrigin))
        errors['environment.auth.identityProviderOrigin'] = t.s1.formatBad;
      need('usernameSelector', auth.usernameSelector);
      need('passwordSelector', auth.passwordSelector);
      need('submitSelector', auth.submitSelector);
    }
    if (auth.type === 'http' && auth.origin && !/^https?:\/\/[^\s/]+/i.test(auth.origin))
      errors['environment.auth.origin'] = t.s1.formatBad;
  }
  return errors;
}

// ————————————————————————————————————————————— cadre

export function render(state: WizardState): string {
  const { t } = state;
  if (state.phase !== 'ready') {
    const inner =
      state.phase === 'loading'
        ? `<div class="center" role="status"><div><span class="spin"></span><p>${esc(t.loading)}</p></div></div>`
        : `<div class="center" role="alert"><div><div class="medal e" style="margin:0 auto 12px">${icon('stop')}</div><h1>${esc(t.serverDown)}</h1><p class="lead">${esc(state.loadError)}</p><p><button class="btn p" data-act="reload">${icon('refresh')}${esc(t.retry)}</button></p></div></div>`;
    return frame(state, `<div class="ct">${inner}</div>`);
  }
  const content =
    state.step === 1
      ? stepProject(state)
      : state.step === 2
        ? stepEnvironment(state)
        : state.step === 3
          ? stepExploration(state)
          : state.step === 4
            ? stepSummary(state)
            : stepRun(state);
  return frame(
    state,
    `${panel(state)}<div class="ct">${hsteps(state)}<div class="prog"><i style="width:${String(state.step * 20)}%"></i></div>${content}</div>`,
  );
}

function frame(state: WizardState, inner: string): string {
  const { t } = state;
  const logo = state.logo ? `<img src="${esc(state.logo)}" alt="">` : '<i></i>';
  return `<div class="win"><header class="bar"><span class="logo">${logo}</span><span class="nm hd">${esc(state.productName ?? t.product)}</span><span class="tag">${esc(t.tag)}</span><span class="sp"></span></header><div class="stage"><main class="card" aria-label="${esc(t.newProject)}">${inner}</main></div></div>`;
}

function stepClass(state: WizardState, n: StepNumber): string {
  const blocked = stepsWithBlocking(state);
  if (blocked.has(n) && state.step >= 4) return 'err';
  if (n === state.step) return 'on';
  if (n < state.step || (n <= state.visited && n !== state.step))
    return n === 5 && !state.run ? 'todo' : 'done';
  return 'todo';
}

function stepsWithBlocking(state: WizardState): Set<number> {
  const steps = new Set<number>();
  for (const issue of state.validation?.blocking ?? [])
    steps.add(issue.step === 'project' ? 1 : issue.step === 'environment' ? 2 : 3);
  return steps;
}

function canGoTo(state: WizardState, n: StepNumber): boolean {
  if (state.run && n !== 5) return false;
  if (n === 5) return Boolean(state.run);
  return n <= state.visited && n !== state.step;
}

function panel(state: WizardState): string {
  const { t } = state;
  const steps = t.steps
    .map(([title, sub], index) => {
      const n = (index + 1) as StepNumber;
      const cls = stepClass(state, n);
      const mark =
        cls === 'done'
          ? icon('check', 'style="width:15px;height:15px;stroke-width:3"')
          : cls === 'err'
            ? '!'
            : String(n);
      return `<li class="step ${cls}"><button data-act="goto" data-step="${String(n)}" ${canGoTo(state, n) ? '' : 'disabled'} ${n === state.step ? 'aria-current="step"' : ''}><span class="c">${mark}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span></button></li>`;
    })
    .join('');
  return `<aside class="pan"><h2>${esc(t.newProject)}</h2><ol class="steps">${steps}</ol>${fiche(state)}</aside>`;
}

function hsteps(state: WizardState): string {
  const { t } = state;
  return `<ol class="hsteps" aria-label="${esc(t.newProject)}">${t.steps
    .map(([title], index) => {
      const n = (index + 1) as StepNumber;
      const cls = stepClass(state, n);
      const mark = cls === 'done' ? '✓' : cls === 'err' ? '!' : String(n);
      return `<li class="${cls}"><button data-act="goto" data-step="${String(n)}" ${canGoTo(state, n) ? '' : 'disabled'}><span class="c">${mark}</span>${esc(title)}</button>${n < 5 ? '<span class="sep">—</span>' : ''}</li>`;
    })
    .join('')}</ol>`;
}

function fiche(state: WizardState): string {
  const { t, draft } = state;
  const v = (value: string | undefined): string => (value ? esc(value) : '—');
  let host = '';
  try {
    host = draft.project.targetUrl ? new URL(draft.project.targetUrl).host : '';
  } catch {
    host = '';
  }
  const reachable = state.urlCheck?.reachable?.ok ? '<span style="color:#3DDBB8">●</span> ' : '';
  const step = state.visited;
  const rows: [string, string, boolean][] = [
    [t.ficheRows.name, v(draft.project.name.trim()), Boolean(draft.project.name.trim())],
    [t.ficheRows.url, host ? `${reachable}${esc(host)}` : '—', Boolean(host)],
    [
      t.ficheRows.type,
      esc(t.s1.frameworks[draft.project.framework]?.[0] ?? draft.project.framework),
      step >= 1,
    ],
    [
      t.ficheRows.browser,
      step >= 2
        ? `Chromium · ${String(draft.environment.viewport.width)} × ${String(draft.environment.viewport.height)}`
        : '—',
      step >= 2,
    ],
    [t.ficheRows.access, step >= 2 ? esc(t.s2.authTypes[draft.environment.auth.type]) : '—', step >= 2],
    [
      t.ficheRows.budget,
      step >= 3
        ? `${String(draft.exploration.maxStates)} · ${String(draft.exploration.maxDurationMinutes)} ${esc(t.s3.minutes)}`
        : '—',
      step >= 3,
    ],
  ];
  return `<section class="fiche" aria-label="${esc(t.fiche)}"><div class="t"><i></i>${esc(t.fiche)}</div><dl>${rows
    .map(([k, value, filled]) => `<dt>${esc(k)}</dt><dd class="${filled ? '' : 'e'}">${value}</dd>`)
    .join('')}</dl></section>`;
}

function head(state: WizardState, n: number, title: string, lead: string): string {
  return `<div><div class="eb">${esc(state.t.stepOf(n))}</div><h1>${esc(title)}</h1><p class="lead">${esc(lead)}</p></div>`;
}

function footer(
  state: WizardState,
  options: {
    back?: boolean;
    next?: string;
    extra?: string;
    note?: string;
    nextDisabled?: boolean;
    nextAct?: string;
  } = {},
): string {
  const { t } = state;
  const back =
    options.back === false
      ? ''
      : `<button class="btn" data-act="back">${icon('arrowL')}${esc(t.back)}</button>`;
  const next = options.next ?? `${esc(t.next)}${icon('arrowR')}`;
  return `<footer class="ft">${back}${options.note ?? ''}<span class="sp"></span>${options.extra ?? ''}<button class="btn p" data-act="${options.nextAct ?? 'next'}" ${options.nextDisabled ? 'disabled' : ''}>${next}</button></footer>`;
}

function field(
  state: WizardState,
  errors: Record<string, string>,
  bind: string,
  label: string,
  value: string | number | undefined,
  options: {
    icon?: string;
    type?: string;
    placeholder?: string;
    hint?: string;
    optional?: boolean;
    mono?: boolean;
    suffix?: string;
    min?: number;
    max?: number;
  } = {},
): string {
  const step = state.step;
  const error = state.showErrors[step] ? errors[bind] : undefined;
  const id = `f-${bind.replace(/\./g, '-')}`;
  const describedBy = error ? `${id}-err` : options.hint ? `${id}-hint` : '';
  return `<div class="f"><label for="${id}">${esc(label)}${options.optional ? ` <em>${esc(state.t.s1.optional)}</em>` : ''}</label><div class="ip${error ? ' bad' : ''}">${options.icon ? icon(options.icon) : ''}<input id="${id}" data-bind="${esc(bind)}" ${options.type === 'number' ? 'data-type="number"' : ''} type="${options.type ?? 'text'}" value="${esc(value ?? '')}" ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''} ${options.mono ? 'class="mono"' : ''} ${options.min !== undefined ? `min="${String(options.min)}"` : ''} ${options.max !== undefined ? `max="${String(options.max)}"` : ''} ${error ? 'aria-invalid="true"' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''} autocomplete="off" spellcheck="false">${options.suffix ? `<span class="hint">${esc(options.suffix)}</span>` : ''}</div>${error ? `<span class="err-t" id="${id}-err">${esc(error)}</span>` : options.hint ? `<span class="hint" id="${id}-hint">${esc(options.hint)}</span>` : ''}</div>`;
}

// ————————————————————————————————————————————— étape 1

function stepProject(state: WizardState): string {
  const { t, draft } = state;
  const errors = stepErrors(draft, 1, t);
  let c = head(state, 1, t.s1.title, t.s1.lead);
  c += `<div class="grid2">${field(state, errors, 'project.name', t.s1.name, draft.project.name, { icon: 'folder', hint: t.s1.nameHint })}`;
  c += `<div class="f"><label for="f-project-description">${esc(t.s1.description)} <em>${esc(t.s1.optional)}</em></label><div class="ip">${icon('text')}<input id="f-project-description" data-bind="project.description" value="${esc(draft.project.description ?? '')}" placeholder="${esc(t.s1.descriptionPh)}" autocomplete="off"></div></div></div>`;
  const urlError = state.showErrors[1] ? errors['project.targetUrl'] : undefined;
  c += `<div class="f"><label for="f-project-targetUrl">${esc(t.s1.url)}</label><div class="ip${urlError ? ' bad' : ''}">${icon('link')}<input id="f-project-targetUrl" class="mono" data-bind="project.targetUrl" type="url" value="${esc(draft.project.targetUrl)}" placeholder="https://" autocomplete="off" spellcheck="false" ${urlError ? 'aria-invalid="true"' : ''}><button class="btn sm" data-act="check-url" ${state.urlChecking ? 'disabled' : ''}>${state.urlChecking ? `<span class="spin" style="width:14px;height:14px;border-width:2px"></span>${esc(t.s1.checking)}` : `${icon('refresh')}${esc(t.s1.check)}`}</button></div>${urlError ? `<span class="err-t">${esc(urlError)}</span>` : ''}${urlChecks(state)}</div>`;
  const tiles = (['angular', 'react', 'vue', 'salesforce', 'other'] as const)
    .map((framework) => {
      const [title, description] = t.s1.frameworks[framework] ?? [framework, ''];
      const glyph = { angular: 'shield', react: 'atom', vue: 'vee', salesforce: 'cloud', other: 'grid' }[
        framework
      ];
      return `<button class="tile" role="radio" aria-checked="${String(draft.project.framework === framework)}" data-act="framework" data-value="${framework}"><span class="tick">${icon('check')}</span><span class="gl">${icon(glyph)}</span><span><b>${esc(title)}</b><br><span class="d">${esc(description)}</span></span></button>`;
    })
    .join('');
  c += `<div class="f"><span class="l" id="l-type">${esc(t.s1.type)}</span><div class="tiles" role="radiogroup" aria-labelledby="l-type">${tiles}</div><span class="hint">${esc(t.s1.typeHint)}</span></div>`;
  if (draft.project.framework === 'angular' && state.caps?.staticAnalysis)
    c += field(state, errors, 'project.sourceRoot', t.s1.source, draft.project.sourceRoot, {
      icon: 'code',
      optional: true,
      mono: true,
      hint: t.s1.sourceHint,
    });
  return `<div class="in2">${c}</div>${footer(state, { back: false, note: `<span class="kbd">${esc(t.draftKept)}</span>` })}`;
}

function urlChecks(state: WizardState): string {
  const { t } = state;
  const check = state.urlCheck;
  if (!check) return '';
  if (!check.format.ok)
    return `<div class="chk"><span class="ck e">${icon('x')}${esc(t.s1.formatBad)}</span></div>`;
  const parts = [`<span class="ck ok">${icon('check')}${esc(t.s1.formatOk)}</span>`];
  const reach = check.reachable;
  if (reach?.ok)
    parts.push(
      `<span class="ck ok">${icon('check')}${esc(t.s1.reachable(reach.status ?? 0, reach.durationMs))}</span>`,
    );
  else if (reach)
    parts.push(
      `<span class="ck w wrapmsg">${icon('alert')}${esc(t.s1.unreachable(reach.message ?? `HTTP ${String(reach.status ?? '?')}`))}</span>`,
    );
  return `<div class="chk" role="status">${parts.join('')}</div>`;
}

// ————————————————————————————————————————————— étape 2

const VIEWPORTS: [number, number][] = [
  [1366, 768],
  [1280, 720],
  [1440, 900],
  [1536, 864],
  [1920, 1080],
  [390, 844],
];
const LOCALES = ['fr-FR', 'fr-CA', 'en-US', 'en-GB', 'en-CA', 'es-ES', 'de-DE'];

function stepEnvironment(state: WizardState): string {
  const { t, draft } = state;
  const env = draft.environment;
  const errors = stepErrors(draft, 2, t);
  const current = `${String(env.viewport.width)}x${String(env.viewport.height)}`;
  const viewports = VIEWPORTS.some(([w, h]) => `${String(w)}x${String(h)}` === current)
    ? VIEWPORTS
    : [[env.viewport.width, env.viewport.height] as [number, number], ...VIEWPORTS];
  let c = head(state, 2, t.s2.title, t.s2.lead);
  c += `<div class="grid3"><div class="f"><span class="l">${esc(t.s2.browser)}</span><div class="ip">${icon('globe')}<span class="static">Chromium</span><span class="ck n">${esc(t.s2.onlyEngine)}</span></div></div>`;
  c += `<div class="f"><label for="f-viewport">${esc(t.s2.viewport)}</label><div class="ip">${icon('monitor')}<select id="f-viewport" data-bind="environment.viewport" data-type="viewport">${viewports
    .map(
      ([w, h]) =>
        `<option value="${String(w)}x${String(h)}" ${`${String(w)}x${String(h)}` === current ? 'selected' : ''}>${String(w)} × ${String(h)}</option>`,
    )
    .join('')}</select></div></div>`;
  c += `<div class="f"><label for="f-locale">${esc(t.s2.locale)}</label><div class="ip">${icon('text')}<select id="f-locale" data-bind="environment.locale"><option value="" ${env.locale ? '' : 'selected'}>${esc(t.s2.localeDefault)}</option>${LOCALES.map((l) => `<option ${env.locale === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div></div>`;
  c += `<div class="grid2">${field(state, errors, 'environment.actionTimeoutMs', t.s2.actionTimeout, Math.round(env.actionTimeoutMs / 1000), { icon: 'clock', type: 'number', suffix: t.s2.seconds, min: 1, max: 120 })}${field(state, errors, 'environment.navigationTimeoutMs', t.s2.navigationTimeout, Math.round(env.navigationTimeoutMs / 1000), { icon: 'clock', type: 'number', suffix: t.s2.seconds, min: 1, max: 180 })}</div>`;
  c += `<div class="f"><span class="l" id="l-auth">${esc(t.s2.auth)}</span><div class="seg" role="radiogroup" aria-labelledby="l-auth">${(
    ['none', 'form', 'http', 'sso'] as const
  )
    .map(
      (type) =>
        `<button role="radio" aria-checked="${String(env.auth.type === type)}" data-act="auth" data-value="${type}">${type === 'form' && env.auth.type === 'form' ? icon('lock') : ''}${esc(t.s2.authTypes[type])}</button>`,
    )
    .join('')}</div></div>`;
  if (env.auth.type !== 'none') c += authBox(state, env.auth, errors);
  return `<div class="in2">${c}</div>${footer(state)}`;
}

function authBox(
  state: WizardState,
  auth: Exclude<AuthDraft, { type: 'none' }>,
  errors: Record<string, string>,
): string {
  const { t } = state;
  const f = (key: string, label: string, value: string | undefined, optional = false): string =>
    field(state, errors, `environment.auth.${key}`, label, value, { mono: true, optional });
  let c = '';
  if (auth.type === 'form')
    c += `<div class="grid2">${f('loginUrl', t.s2.loginUrl, auth.loginUrl)}${f('successUrlContains', t.s2.successUrl, auth.successUrlContains, true)}</div><div class="grid3">${f('usernameSelector', t.s2.usernameSelector, auth.usernameSelector)}${f('passwordSelector', t.s2.passwordSelector, auth.passwordSelector)}${f('submitSelector', t.s2.submitSelector, auth.submitSelector)}</div>`;
  if (auth.type === 'http')
    c += `<div class="grid2">${f('origin', t.s2.httpOrigin, auth.origin, true)}</div>`;
  if (auth.type === 'sso')
    c += `<div class="grid2">${f('identityProviderOrigin', t.s2.idpOrigin, auth.identityProviderOrigin)}${f('successUrlContains', t.s2.successUrl, auth.successUrlContains, true)}</div><div class="grid2">${f('usernameSelector', t.s2.usernameSelector, auth.usernameSelector)}${f('passwordSelector', t.s2.passwordSelector, auth.passwordSelector)}${f('submitSelector', t.s2.submitSelector, auth.submitSelector)}${f('nextSelector', t.s2.nextSelector, auth.nextSelector, true)}</div>`;
  c += `<div class="grid2">${f('usernameEnv', t.s2.usernameEnv, auth.usernameEnv)}${f('passwordEnv', t.s2.passwordEnv, auth.passwordEnv)}</div>`;
  const vars = [auth.usernameEnv, auth.passwordEnv]
    .filter((name) => ENV_NAME_PATTERN.test(name))
    .map((name) => {
      const known = state.env[name];
      const cls = known === undefined ? '' : known ? 'ok' : 'e';
      const word = known === undefined ? '…' : known ? t.s2.defined : t.s2.undefined;
      return `<span class="var"><span class="dt ${cls}"></span><span class="mono">${esc(name)}</span> ${esc(word)}</span>`;
    })
    .join('');
  c += `<div class="lock">${icon('key')}<div><b>${esc(t.s2.lockTitle)}</b> ${esc(t.s2.lockText)}<div class="chk" style="margin-top:10px" role="status">${vars}</div></div></div>`;
  return `<div class="box">${c}</div>`;
}

// ————————————————————————————————————————————— étape 3

function stepExploration(state: WizardState): string {
  const { t, draft } = state;
  const x = draft.exploration;
  const range = (
    key: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    engineName: string,
    unit = '',
  ): string =>
    `<div class="rng"><div class="lab"><label for="r-${key}">${esc(label)} <span class="hint mono" style="margin-left:6px">${engineName}</span></label><span><input type="number" aria-label="${esc(label)}" data-bind="exploration.${key}" data-type="number" min="${String(min)}" max="${String(max)}" value="${String(value)}">${unit ? ` ${esc(unit)}` : ''}</span></div><input id="r-${key}" type="range" data-bind="exploration.${key}" data-type="number" min="${String(min)}" max="${String(max)}" step="${String(step)}" value="${String(Math.min(value, max))}"></div>`;
  let c = head(state, 3, t.s3.title, t.s3.lead);
  c += `<section class="box white"><h3>${icon('target')}${esc(t.s3.budget)}</h3><div class="grid2">${range('maxStates', t.s3.states, x.maxStates, 1, 500, 1, 'maxStates')}${range('maxActions', t.s3.actions, x.maxActions, 1, 5000, 10, 'maxActions')}${range('maxDurationMinutes', t.s3.duration, x.maxDurationMinutes, 1, 240, 1, 'maxDurationMinutes', t.s3.minutes)}${range('maxDepth', t.s3.depth, x.maxDepth, 0, 50, 1, 'maxDepth')}</div></section>`;
  const fixed = new Set(state.caps?.defaults.exploration.ignoredPaths ?? []);
  const chips = (list: string[], kind: 'hosts' | 'paths'): string =>
    list
      .map((item, index) =>
        kind === 'paths' && fixed.has(item)
          ? `<span class="chip mono fixed" title="${esc(t.s3.pathsHint)}">${icon('lock', 'style="width:12px;height:12px"')}${esc(item)}</span>`
          : `<span class="chip mono">${esc(item)}<button data-act="remove-${kind}" data-index="${String(index)}" aria-label="${esc(t.s3.remove)} ${esc(item)}">${icon('x', 'style="width:12px;height:12px"')}</button></span>`,
      )
      .join('');
  const adder = (kind: 'hosts' | 'paths', placeholder: string): string =>
    `<span class="adder"><input data-pending="${kind}" class="mono" placeholder="${esc(placeholder)}" value="${esc(state.pending[kind === 'hosts' ? 'host' : 'path'])}" aria-label="${esc(kind === 'hosts' ? t.s3.hosts : t.s3.paths)}"><button class="btn sm" data-act="add-${kind}">+ ${esc(t.s3.add)}</button></span>`;
  c += `<div class="grid2"><section class="box"><h3>${icon('route')}${esc(t.s3.scope)}</h3><div class="f"><span class="l">${esc(t.s3.hosts)}</span><div class="chips">${chips(x.allowedHosts, 'hosts')}${adder('hosts', 'app.example.com')}</div><span class="hint">${esc(t.s3.hostsHint)}</span></div><div class="f"><span class="l">${esc(t.s3.paths)}</span><div class="chips">${chips(x.ignoredPaths, 'paths')}${adder('paths', '/admin')}</div><span class="hint">${esc(t.s3.pathsHint)}</span></div></section>`;
  const toggle = (key: string, [title, sub]: string[], checked: boolean, disabled = false): string =>
    `<label class="tg"><span class="sw"><input type="checkbox" role="switch" ${disabled ? 'disabled' : `data-bind="exploration.checks.${key}" data-type="boolean"`} ${checked ? 'checked' : ''}></span><span><b>${esc(title)}</b><span>${esc(sub)}</span></span></label>`;
  c += `<section class="box"><h3>${icon('eye')}${esc(t.s3.collect)}</h3>${toggle('pageErrors', t.s3.pageErrors, x.checks.pageErrors)}${toggle('network', t.s3.network, x.checks.network)}${toggle('screenshots', t.s3.screenshots, x.checks.screenshots)}${toggle('mutations', t.s3.mutations, false, true)}</section></div>`;
  return `<div class="in2">${c}</div>${footer(state)}`;
}

// ————————————————————————————————————————————— étape 4

function stepSummary(state: WizardState): string {
  const { t, draft } = state;
  let c = head(state, 4, t.s4.title, t.s4.lead);
  const report = state.validation;
  if (state.validating && !report)
    c += `<div class="alert" role="status"><span class="spin"></span>${esc(t.s4.validating)}</div>`;
  if (report) {
    if (report.blocking.length > 0)
      c += `<div class="alert e" role="alert">${icon('stop')}<div><b>${esc(t.s4.blocking(report.blocking.length))}</b><ul>${report.blocking
        .map(
          (issue) =>
            `<li>${esc(issue.message)} <button class="link" data-act="goto" data-step="${issue.step === 'project' ? '1' : issue.step === 'environment' ? '2' : '3'}">${esc(t.s4.edit)}</button></li>`,
        )
        .join('')}</ul></div></div>`;
    if (report.warnings.length > 0)
      c += `<div class="alert w" role="status">${icon('alert')}<div><b>${esc(t.s4.warnings(report.warnings.length))}</b><ul>${report.warnings.map((issue) => `<li>${esc(issue.message)}</li>`).join('')}</ul></div></div>`;
    if (report.ok && report.warnings.length === 0)
      c += `<div class="alert ok" role="status">${icon('check')}<div><b>${esc(t.s4.valid)}</b></div></div>`;
  }
  if (state.actionError)
    c += `<div class="alert e" role="alert">${icon('stop')}<div>${esc(state.actionError)}</div></div>`;
  if (state.project)
    c += `<div class="alert ok" role="status">${icon('check')}<div><b>${esc(t.s4.saved(state.project.id))}</b></div></div>`;
  const auth = draft.environment.auth;
  const envState = (name: string): string =>
    report?.environment[name] === false
      ? `<span style="color:var(--qa-color-danger)">● ${esc(name)}</span>`
      : esc(name);
  const card = (n: number, ico: string, title: string, rows: [string, string][]): string =>
    `<div class="rcard"><div class="h"><span class="gl">${icon(ico)}</span><b>${esc(title)}</b><button data-act="goto" data-step="${String(n)}">${esc(t.s4.edit)}</button></div><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div>`;
  let host = draft.project.targetUrl;
  try {
    host = new URL(draft.project.targetUrl).host;
  } catch {
    // l'adresse invalide est signalée par la validation
  }
  c += `<div class="rc">${card(1, 'folder', t.s4.cards.project, [
    [t.s4.rows.name, esc(draft.project.name)],
    [t.s4.rows.url, `<span class="mono">${esc(host)}</span>`],
    [t.s4.rows.type, esc(t.s1.frameworks[draft.project.framework]?.[0] ?? draft.project.framework)],
  ])}${card(2, 'monitor', t.s4.cards.environment, [
    [t.s4.rows.browser, 'Chromium'],
    [
      t.s4.rows.window,
      `${String(draft.environment.viewport.width)} × ${String(draft.environment.viewport.height)}${draft.environment.locale ? ` · ${esc(draft.environment.locale)}` : ''}`,
    ],
    [
      t.s4.rows.delays,
      `${String(Math.round(draft.environment.actionTimeoutMs / 1000))} s · ${String(Math.round(draft.environment.navigationTimeoutMs / 1000))} s`,
    ],
    [
      t.s4.rows.access,
      auth.type === 'none'
        ? esc(t.s2.authTypes.none)
        : `${esc(t.s2.authTypes[auth.type])} · ${envState(auth.usernameEnv)}, ${envState(auth.passwordEnv)}`,
    ],
  ])}${card(3, 'target', t.s4.cards.exploration, [
    [t.s4.rows.budget, esc(t.s4.budgetValue(draft.exploration.maxStates, draft.exploration.maxActions))],
    [
      t.s4.rows.duration,
      esc(t.s4.durationValue(draft.exploration.maxDurationMinutes, draft.exploration.maxDepth)),
    ],
    [
      t.s4.rows.scope,
      esc(
        t.s4.scopeValue(
          Math.max(1, draft.exploration.allowedHosts.length),
          draft.exploration.ignoredPaths.length,
        ),
      ),
    ],
    [t.s4.rows.writes, esc(t.s4.rows.forbidden)],
  ])}</div>`;
  if (report?.projectFile)
    c += `<div class="f"><span class="l">${esc(t.s4.file)}</span><pre class="yaml">${yaml(report.projectFile)}</pre></div>`;
  const ok = Boolean(report?.ok) && !state.busy;
  const save = state.project
    ? ''
    : `<button class="btn g" data-act="save" ${ok ? '' : 'disabled'}>${esc(t.s4.save)}</button>`;
  return `<div class="in2">${c}</div>${footer(state, { next: `${icon('play')}${esc(t.s4.launch)}`, nextAct: 'launch', nextDisabled: !ok, extra: save })}`;
}

function yaml(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return `<span class="c">${esc(line)}</span>`;
      const match = /^(\s*-?\s*)([A-Za-z0-9_]+)(:)(.*)$/.exec(line);
      return match
        ? `${esc(match[1])}<span class="k">${esc(match[2])}</span>${esc(match[3])}${esc(match[4])}`
        : esc(line);
    })
    .join('\n');
}

// ————————————————————————————————————————————— étape 5

export function ringSvg(fraction: number): string {
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const value = Math.max(0, Math.min(1, fraction));
  return `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${String(r)}" fill="none" stroke="var(--qa-color-border)" stroke-width="7"/><circle cx="32" cy="32" r="${String(r)}" fill="none" stroke="var(--qa-color-primary)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(circumference * value).toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 32 32)"/></svg>`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

export function formatDuration(ms: number, locale: 'fr' | 'en'): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${String(s)} s`;
  return locale === 'fr' ? `${String(m)} min ${String(s)} s` : `${String(m)} min ${String(s)} s`;
}

export interface MapLayout {
  width: number;
  height: number;
  nodes: (MapNode & { x: number; y: number; depth: number })[];
  edges: { x1: number; y1: number; x2: number; y2: number }[];
  hidden: number;
}

/** La carte des écrans : profondeur en largeur (BFS depuis le premier écran), une colonne par profondeur. */
export function layoutMap(nodes: MapNode[], edges: { from: string; to: string }[], maxNodes = 40): MapLayout {
  const shown = nodes.slice(0, maxNodes);
  const ids = new Set(shown.map((node) => node.id));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const depth = new Map<string, number>();
  for (const root of shown) {
    if (depth.has(root.id)) continue;
    const base = depth.size === 0 ? 0 : 0;
    depth.set(root.id, base);
    const queue = [root.id];
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      for (const next of adjacency.get(current) ?? []) {
        if (depth.has(next)) continue;
        depth.set(next, (depth.get(current) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  const columns = new Map<number, number>();
  const W = 168;
  const H = 46;
  const placed = shown.map((node) => {
    const d = Math.min(depth.get(node.id) ?? 0, 6);
    const row = columns.get(d) ?? 0;
    columns.set(d, row + 1);
    return { ...node, depth: d, x: 76 + d * W, y: 24 + row * H };
  });
  const position = new Map(placed.map((node) => [node.id, node]));
  const lines = edges
    .filter(
      (edge, index, all) =>
        edge.from !== edge.to && all.findIndex((e) => e.from === edge.from && e.to === edge.to) === index,
    )
    .map((edge) => [position.get(edge.from), position.get(edge.to)] as const)
    .filter((pair): pair is readonly [MapLayout['nodes'][number], MapLayout['nodes'][number]] =>
      Boolean(pair[0] && pair[1]),
    )
    .map(([a, b]) => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }));
  const maxDepth = Math.max(0, ...placed.map((node) => node.depth));
  const maxRows = Math.max(1, ...columns.values());
  return {
    width: 152 + maxDepth * W,
    height: 48 + (maxRows - 1) * H,
    nodes: placed,
    edges: lines,
    hidden: nodes.length - shown.length,
  };
}

function mapSvg(run: RunState, issueRoutes: Set<string>): string {
  const layout = layoutMap(run.nodes, run.edges);
  const label = (text: string): string => (text.length > 20 ? `${text.slice(0, 19)}…` : text);
  const edges = layout.edges
    .map(
      (e) =>
        `<path d="M${String(e.x1)},${String(e.y1)} C${String((e.x1 + e.x2) / 2)},${String(e.y1)} ${String((e.x1 + e.x2) / 2)},${String(e.y2)} ${String(e.x2)},${String(e.y2)}" fill="none" stroke="color-mix(in srgb,var(--qa-color-primary) 35%,transparent)" stroke-width="2"/>`,
    )
    .join('');
  const nodes = layout.nodes
    .map((n) => {
      const warn = issueRoutes.has(n.route);
      const fill = warn ? 'var(--qa-color-warning)' : 'var(--qa-color-primary)';
      return `<g><title>${esc(n.label)} · ${esc(n.route)}</title><rect x="${String(n.x - 70)}" y="${String(n.y - 15)}" width="140" height="30" rx="15" fill="${fill}"/><text x="${String(n.x)}" y="${String(n.y + 4)}" text-anchor="middle" font-family="var(--qa-font-family-mono)" font-size="11" fill="#fff">${esc(label(n.route || n.label))}</text></g>`;
    })
    .join('');
  return `<svg width="${String(layout.width)}" height="${String(layout.height)}" viewBox="0 0 ${String(layout.width)} ${String(layout.height)}" role="img">${edges}${nodes}</svg>${layout.hidden > 0 ? `<p class="hint">+${String(layout.hidden)}</p>` : ''}`;
}

const EVENT_ICON: Record<string, string> = {
  state: 'eye',
  transition: 'arrowR',
  issue: 'alert',
  blocked: 'ban',
  authenticated: 'key',
  phase: 'spark',
  status: 'clock',
  completed: 'check',
  failed: 'stop',
};

function eventText(state: WizardState, event: ExplorationEvent): string | undefined {
  const e = state.t.s5.events;
  switch (event.type) {
    case 'authenticated':
      return esc(e.authenticated(event.message));
    case 'state':
      return e.state(esc(event.label || event.title || event.route));
    case 'transition':
      return event.changed ? esc(e.transition(event.action)) : undefined;
    case 'blocked':
      return esc(e.blocked(event.action, event.reason));
    case 'issue':
      return e.issue(esc(state.t.severity[event.severity] ?? event.severity), esc(event.message));
    case 'phase':
      return esc(e.phase(event.phase));
    case 'status':
      return esc(e.status(state.t.s5.status[event.status] ?? event.status));
    case 'failed':
      return esc(event.error);
    default:
      return undefined;
  }
}

function stepRun(state: WizardState): string {
  const run = state.run;
  if (!run) return '<div class="in2"></div>';
  if (run.summary) return stepDone(state, run.summary);
  if (run.snapshot.status === 'FAILED') return stepFailed(state, run);
  const { t } = state;
  const status = run.snapshot.status;
  const elapsed = run.startedAtMs !== undefined ? (run.finishedAtMs ?? run.now) - run.startedAtMs : 0;
  const budget = run.snapshot.budget;
  const counters = run.counters;
  const issues = counters.issues;
  const issueTotal = issues.INFO + issues.WARNING + issues.ERROR + issues.CRITICAL;
  const worst = issues.CRITICAL ? 'CRITICAL' : issues.ERROR ? 'ERROR' : issues.WARNING ? 'WARNING' : 'INFO';
  const ring = (label: string, value: string, of: string, fraction: number): string =>
    `<div class="ring">${ringSvg(fraction)}<div><small>${esc(label)}</small><b>${esc(value)}</b><em>/ ${esc(of)}</em></div></div>`;
  let c = `<div class="st-head"><div><div class="eb">${esc(t.stepOf(5))}</div><h1>${esc(status === 'QUEUED' ? t.s5.queued : t.s5.running)}</h1>${status === 'QUEUED' ? `<p class="lead">${esc(t.s5.queuedLead)}</p>` : ''}</div><span class="sp"></span><span class="live ${status === 'QUEUED' ? 'q' : ''}" role="status"><i></i>${esc(t.s5.status[status])}</span><span class="meta mono">${esc(run.snapshot.id)}</span></div>`;
  c += `<div class="rings">${ring(t.s5.states, String(counters.states), String(budget.maxStates), counters.states / budget.maxStates)}${ring(t.s5.actions, String(counters.actions), String(budget.maxActions), counters.actions / budget.maxActions)}${ring(t.s5.duration, formatClock(elapsed), formatClock(budget.maxDurationMinutes * 60_000), elapsed / (budget.maxDurationMinutes * 60_000))}<div class="ring"><span class="gl">${icon('alert')}</span><div><small>${esc(t.s5.anomalies)}</small><b>${String(issueTotal)}</b>${issueTotal > 0 ? `<em>${esc(t.severity[worst])}</em>` : ''}</div></div></div>`;
  const issueRoutes = new Set(
    run.events.flatMap((event) => (event.type === 'issue' && event.route ? [event.route] : [])),
  );
  const map =
    run.nodes.length > 0
      ? `<div class="map">${mapSvg(run, issueRoutes)}</div>`
      : `<p class="empty">${esc(t.s5.mapEmpty)}</p>`;
  const feed = journal(state, run);
  c += `<div class="two"><section class="panel"><h3>${icon('route')}${esc(t.s5.map)}<span class="ck n">${esc(t.s5.mapCount(counters.states, counters.transitions))}</span></h3>${map}</section><section class="panel"><h3>${icon('spark')}${esc(t.s5.journal)}</h3>${feed}</section></div>`;
  return `<div class="in2">${c}</div><footer class="ft"><span class="foot-note">${icon('clock')}${esc(t.s5.leave)}</span></footer>`;
}

function journal(state: WizardState, run: RunState): string {
  const lines = [...run.events]
    .reverse()
    .map((event) => {
      const text = eventText(state, event);
      if (!text) return '';
      const at = run.startedAtMs !== undefined ? formatClock(Date.parse(event.at) - run.startedAtMs) : '';
      return `<div class="ev"><time>${esc(at)}</time><span class="bdg b-${event.type}">${icon(EVENT_ICON[event.type] ?? 'spark')}</span><span class="m">${text}</span></div>`;
    })
    .filter(Boolean)
    .slice(0, 60)
    .join('');
  return lines
    ? `<div class="feed" aria-live="polite">${lines}</div>`
    : `<p class="empty">${esc(state.t.s5.journalEmpty)}</p>`;
}

function stepDone(state: WizardState, summary: ExplorationSummary): string {
  const { t } = state;
  const locale = state.locale;
  const stats = summary.stats;
  const sev = stats.issuesBySeverity;
  const total = sev.INFO + sev.WARNING + sev.ERROR + sev.CRITICAL;
  let c = `<div class="st-head"><div class="medal">${icon('check')}</div><div><div class="eb" style="color:var(--qa-color-success)">${esc(t.s6.done)}</div><h1>${esc(t.s6.title(stats.states, formatDuration(summary.durationMs, locale)))}</h1><p class="lead">${esc(t.s6.stop[summary.stopReason] ?? summary.stopReason)}</p></div></div>`;
  const tile = (value: number, label: string, sub = ''): string =>
    `<div class="ring col"><small>${esc(label)}</small><b>${String(value)}</b>${sub ? `<span class="hint">${esc(sub)}</span>` : ''}</div>`;
  c += `<div class="rings">${tile(stats.states, t.s6.states)}${tile(stats.transitions, t.s6.transitions)}${tile(stats.actionsExecuted, t.s6.actions, stats.actionsBlocked ? t.s6.blockedSub(stats.actionsBlocked) : '')}${tile(total, t.s6.anomalies, t.s6.anomaliesSub(sev.CRITICAL, sev.ERROR, sev.WARNING))}</div>`;
  const order = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 } as Record<string, number>;
  const issues = [...summary.issues].sort((a, b) => (order[a.severity] ?? 4) - (order[b.severity] ?? 4));
  const anomalies = issues.length
    ? issues
        .slice(0, 8)
        .map((issue) => {
          const cls =
            issue.severity === 'CRITICAL' || issue.severity === 'ERROR'
              ? 'e'
              : issue.severity === 'WARNING'
                ? 'w'
                : 'n';
          let where = issue.pageUrl;
          try {
            where = new URL(issue.pageUrl).pathname;
          } catch {
            where = issue.pageUrl;
          }
          return `<div class="anom"><span class="ck ${cls}">${esc(t.severity[issue.severity] ?? issue.severity)}</span><span>${esc(issue.message)}</span><span class="where mono" title="${esc(issue.pageUrl)}">${esc(where)}</span></div>`;
        })
        .join('') + (issues.length > 8 ? `<p class="hint">${esc(t.s6.more(total - 8))}</p>` : '')
    : `<p class="empty">${esc(t.s6.none)}</p>`;
  const report = (kind: 'html' | 'json' | 'overviewHtml', ico: string, [title, sub]: string[]): string =>
    summary.reports[kind]
      ? `<div class="rep"><span class="gl">${icon(ico)}</span><div><b>${esc(title)}</b><span>${esc(sub)}</span></div><span class="sp"></span><button class="btn sm" data-act="open-report" data-kind="${kind}">${esc(t.s6.open)}</button></div>`
      : '';
  c += `<div class="two"><section class="panel"><h3>${icon('alert')}${esc(t.s6.anomaliesTitle)}</h3>${anomalies}</section><section class="panel"><h3>${icon('file')}${esc(t.s6.reports)}</h3>${report('html', 'file', t.s6.html)}${report('overviewHtml', 'layers', t.s6.overview)}${report('json', 'code', t.s6.json)}${state.actionError ? `<p class="err-t">${esc(state.actionError)}</p>` : ''}</section></div>`;
  return `<div class="in2">${c}</div>${footer(state, { back: false, next: `${icon('refresh')}${esc(t.s6.again)}`, nextAct: 'again', extra: `<button class="btn g" data-act="edit-project">${esc(t.s6.editProject)}</button>` })}`;
}

function stepFailed(state: WizardState, run: RunState): string {
  const { t } = state;
  const c = `<div class="st-head"><div class="medal e">${icon('stop')}</div><div><div class="eb" style="color:var(--qa-color-danger)">${esc(t.s5.status.FAILED)}</div><h1>${esc(t.s6.failed)}</h1><p class="lead">${esc(t.s6.failedLead)}</p></div></div><div class="alert e" role="alert">${icon('stop')}<div class="mono">${esc(run.error ?? run.snapshot.error ?? '')}</div></div>${journal(state, run)}`;
  return `<div class="in2">${c}</div>${footer(state, { back: false, next: `${icon('refresh')}${esc(t.retry)}`, nextAct: 'again', extra: `<button class="btn g" data-act="edit-project">${esc(t.s6.editProject)}</button>` })}`;
}

export function draftWith(defaults: ProjectDraft, initial: unknown): ProjectDraft {
  const merge = (base: unknown, extra: unknown): unknown => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra))
      return extra === undefined ? base : extra;
    if (!base || typeof base !== 'object' || Array.isArray(base)) return extra;
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(extra as Record<string, unknown>))
      result[key] = merge(result[key], value);
    return result;
  };
  return merge(structuredClone(defaults), initial) as ProjectDraft;
}
