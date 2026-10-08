import type { RawRecordedEvent, RecordedElement } from './model.js';
import { VALIDATED_STATUSES, type RecordingTargetValidation } from './target-validator.js';

/**
 * LIVE TIMELINE — ce que l'humain voit PENDANT l'enregistrement : une ligne par action humaine
 * réellement faite, décrite en langage courant (« Cliquer sur "Continuer" »), avec son statut.
 *
 *   événement brut ─► ligne affichée TOUT DE SUITE (● en cours) ─► validation en arrière-plan (✓ ⚠ ✕)
 *
 * Déterministe et sans IA : uniquement les événements bruts capturés et la validation immédiate
 * des cibles. Jamais une intention, une suggestion ou une action découverte. Le flow final reste
 * construit par processRecording ; la timeline en est l'aperçu humain.
 *
 * Une valeur saisie n'est montrée que dans le panneau, en mémoire (jamais écrite) ; un champ
 * sensible (mot de passe, code, carte) est toujours masqué.
 */
export type LiveActionKind =
  | 'open'
  | 'navigate'
  | 'click'
  | 'fill'
  | 'check'
  | 'uncheck'
  | 'choose'
  | 'select'
  | 'key'
  | 'drag'
  | 'upload'
  | 'dialog';

/** CONFIRMED ✓ · PENDING ● (validation en cours) · AMBIGUOUS ⚠ · FAILED ✕ · UNVERIFIED ○ (aucune validation possible). */
export type LiveActionStatus = 'PENDING' | 'CONFIRMED' | 'AMBIGUOUS' | 'FAILED' | 'UNVERIFIED';

export interface LiveCandidate {
  index: number;
  label: string;
  /** L'élément que l'humain a réellement touché. */
  original: boolean;
}

export interface LiveAction {
  id: string;
  /** 1, 2, 3… (renuméroté après une annulation). */
  index: number;
  kind: LiveActionKind;
  /** « Cliquer sur "Continuer" » — la ligne principale. */
  description: string;
  /** La ligne secondaire : le champ, la page, la destination d'une navigation. */
  detail?: string;
  /** Le chemin de la page où l'action a eu lieu. */
  page: string;
  status: LiveActionStatus;
  /** Pourquoi ce statut, en mots simples. */
  statusText: string;
  /** Les événements bruts de l'action (de son premier à son dernier). */
  rawEventIds: string[];
  /** Première séquence brute qui appartient à l'action (une annulation retire tout depuis là). */
  fromSequence: number;
  lastSequence: number;
  /** La référence de l'élément original dans la page (mise en évidence) et son CSS. */
  ref?: string;
  css?: string;
  /** Les détails techniques (mode développeur, panneau de détails) : jamais une valeur saisie. */
  technical: Record<string, string>;
  /** AMBIGUOUS : les éléments qui correspondent, et celui que l'humain a touché. */
  candidates?: LiveCandidate[];
  /** RESOLVED : l'humain a confirmé l'élément ; IGNORED : il a choisi de laisser l'ambiguïté. */
  resolution?: 'RESOLVED' | 'IGNORED';
  /** Les faits de qualité (vrais, jamais estimés). */
  facts: { stableSelector: boolean; uniqueTarget: boolean; afterRerender: boolean; mergedEvents: number };
  /** Les preuves de la validation (panneau de détails) : nombre de correspondances, effets observés, navigation. */
  evidence: { candidates?: number; effects?: string[]; navigatedTo?: string; reason?: string };
  at: number;
}

export interface LiveSummary {
  actions: number;
  confirmed: number;
  pending: number;
  ambiguous: number;
  failed: number;
  unverified: number;
  /** Les actions qui demandent l'attention de l'humain (ambiguës non résolues, échecs). */
  attention: number;
}

export interface QualityCheck {
  id: 'confirmed' | 'stable' | 'unique' | 'rerender' | 'duplicates' | 'errors';
  ok: boolean;
  /** Combien d'actions passent / sont concernées. */
  passed: number;
  total: number;
}

export interface LiveQuality {
  /** Part des vérifications réussies sur les actions (0–100) ; undefined sans action. */
  score?: number;
  checks: QualityCheck[];
}

type Language = 'fr' | 'en';

const WORDS = {
  fr: {
    open: 'Ouvrir la page',
    navigate: (route: string) => `Aller à ${route}`,
    click: (name: string) => `Cliquer sur "${name}"`,
    clickUnnamed: 'Cliquer sur un élément',
    fill: (value: string, field: string) => `Saisir "${value}" dans "${field}"`,
    fillNoValue: (field: string) => `Saisir dans "${field}"`,
    check: (name: string) => `Cocher "${name}"`,
    uncheck: (name: string) => `Décocher "${name}"`,
    choose: (name: string) => `Choisir "${name}"`,
    select: (option: string, field: string) => `Sélectionner "${option}" dans "${field}"`,
    key: (key: string) => `Appuyer sur ${key === 'Enter' ? 'Entrée' : key === 'Escape' ? 'Échap' : key}`,
    drag: (item: string, zone?: string) => (zone ? `Glisser "${item}" vers "${zone}"` : `Glisser "${item}"`),
    upload: (field: string) => `Joindre un fichier dans "${field}"`,
    dialog: (accepted: boolean) =>
      accepted ? 'Accepter la boîte de dialogue' : 'Refuser la boîte de dialogue',
    pending: 'Validation…',
    confirmed: 'Action confirmée',
    confirmedFragile: 'Action confirmée (sélecteur fragile)',
    confirmedRerender: "Action confirmée après un nouveau rendu de l'écran",
    ambiguous: (count: number) => `${String(count)} éléments correspondent`,
    resolved: "Ambiguïté résolue : l'élément touché est confirmé",
    ignored: 'Ambiguïté laissée telle quelle (à vérifier au rejeu)',
    failed: 'Élément non retrouvé : à vérifier au rejeu',
    unverified: 'Enregistrée (non vérifiable)',
    opened: 'Page ouverte',
    navigatedTo: (route: string) => `→ ${route}`,
    element: 'élément',
    touched: 'élément touché',
    touchedElement: (name: string) =>
      `${name} — l'élément que vous avez touché (mis en évidence dans la page)`,
    position: (index: number) => `n° ${String(index + 1)}`,
  },
  en: {
    open: 'Open the page',
    navigate: (route: string) => `Go to ${route}`,
    click: (name: string) => `Click "${name}"`,
    clickUnnamed: 'Click an element',
    fill: (value: string, field: string) => `Type "${value}" in "${field}"`,
    fillNoValue: (field: string) => `Type in "${field}"`,
    check: (name: string) => `Check "${name}"`,
    uncheck: (name: string) => `Uncheck "${name}"`,
    choose: (name: string) => `Choose "${name}"`,
    select: (option: string, field: string) => `Select "${option}" in "${field}"`,
    key: (key: string) => `Press ${key}`,
    drag: (item: string, zone?: string) => (zone ? `Drag "${item}" to "${zone}"` : `Drag "${item}"`),
    upload: (field: string) => `Attach a file in "${field}"`,
    dialog: (accepted: boolean) => (accepted ? 'Accept the dialog' : 'Dismiss the dialog'),
    pending: 'Validating…',
    confirmed: 'Action confirmed',
    confirmedFragile: 'Action confirmed (fragile selector)',
    confirmedRerender: 'Action confirmed after the screen re-rendered',
    ambiguous: (count: number) => `${String(count)} elements match`,
    resolved: 'Ambiguity resolved: the touched element is confirmed',
    ignored: 'Ambiguity left as is (to check at replay)',
    failed: 'Element not found again: to check at replay',
    unverified: 'Recorded (not verifiable)',
    opened: 'Page opened',
    navigatedTo: (route: string) => `→ ${route}`,
    element: 'element',
    touched: 'touched element',
    touchedElement: (name: string) => `${name} — the element you touched (highlighted in the page)`,
    position: (index: number) => `#${String(index + 1)}`,
  },
} as const;

const MASK = '••••';
/** Une navigation qui suit un clic de si près en est l'effet (jamais une action à part). */
const NAVIGATION_EFFECT_MS = 5_000;

export class LiveTimeline {
  private readonly list: LiveAction[] = [];
  private counter = 0;
  /** La dernière séquence brute prise en compte (une annulation retire depuis la fin de l'action d'avant). */
  private lastSequence = 0;

  constructor(
    readonly language: Language = 'fr',
    /** Une validation des cibles a lieu (sinon une action reste « non vérifiable », jamais « confirmée »). */
    private readonly validating = true,
  ) {}

  get actions(): readonly LiveAction[] {
    return this.list;
  }

  private get words(): (typeof WORDS)[Language] {
    return WORDS[this.language];
  }

  /**
   * Un événement brut capturé. Renvoie l'action créée ou mise à jour (undefined : rien d'humain à
   * montrer — bruit, contrôle, point de contrôle).
   */
  onEvent(event: RawRecordedEvent, ref?: string): LiveAction | undefined {
    const from = this.lastSequence + 1;
    this.lastSequence = Math.max(this.lastSequence, event.sequence);
    const last = this.list.at(-1);
    // Le bruit (clic de focus, clic sur un libellé de case…) appartient à l'action qui suit.
    if (event.noise) {
      if (last && last.kind === 'fill' && last.css === event.element?.css) this.extend(last, event);
      return undefined;
    }
    const page = routeOf(event.url);
    const element = event.element;
    switch (event.type) {
      case 'navigation': {
        if (this.list.length === 0)
          return this.add(
            event,
            from,
            { kind: 'open', description: this.words.open, detail: page, page },
            true,
          );
        // L'effet du clic qui l'a causée : la destination s'affiche sur le clic (jamais une étape).
        if (
          last &&
          (last.kind === 'click' || last.kind === 'key') &&
          event.at - last.at <= NAVIGATION_EFFECT_MS
        ) {
          this.extend(last, event);
          last.detail = this.words.navigatedTo(page);
          last.evidence.navigatedTo = page;
          return last;
        }
        return this.add(
          event,
          from,
          { kind: 'navigate', description: this.words.navigate(page), page },
          true,
        );
      }
      case 'click':
      case 'submit': {
        if (!element) return undefined;
        const name = nameOf(element);
        return this.add(
          event,
          from,
          { kind: 'click', description: name ? this.words.click(name) : this.words.clickUnnamed, page },
          false,
          ref,
        );
      }
      case 'input':
      case 'change': {
        if (!element) return undefined;
        const field = fieldOf(element) ?? this.words.element;
        if (isToggle(element) && event.value?.checked !== undefined) {
          const radio = element.inputType === 'radio' || element.role === 'radio';
          const kind: LiveActionKind = radio ? 'choose' : event.value.checked ? 'check' : 'uncheck';
          const description = radio
            ? this.words.choose(field)
            : event.value.checked
              ? this.words.check(field)
              : this.words.uncheck(field);
          return this.add(event, from, { kind, description, page }, false, ref);
        }
        const option = event.value?.option?.label;
        if (option !== undefined && (element.tag === 'select' || element.hasOptions || element.customSelect))
          return this.add(
            event,
            from,
            { kind: 'select', description: this.words.select(option, field), page },
            false,
            ref,
          );
        // Les saisies d'un même champ : UNE ligne, la valeur finale.
        if (last && last.kind === 'fill' && last.css === element.css && last.technical.field === field) {
          this.extend(last, event, ref);
          if (event.value?.sensitive) last.description = this.words.fill(MASK, field);
          this.pending(last);
          return last;
        }
        const action = this.add(
          event,
          from,
          {
            kind: 'fill',
            description: event.value?.sensitive
              ? this.words.fill(MASK, field)
              : this.words.fillNoValue(field),
            page,
          },
          false,
          ref,
        );
        action.technical.field = field;
        if (event.value?.sensitive) action.technical.sensitive = 'true';
        return action;
      }
      case 'keydown':
        return event.key
          ? this.add(event, from, { kind: 'key', description: this.words.key(event.key), page }, true)
          : undefined;
      case 'drag':
        return event.drag
          ? this.add(
              event,
              from,
              {
                kind: 'drag',
                description: this.words.drag(
                  event.drag.item,
                  event.drag.destination?.section ?? event.drag.destination?.label,
                ),
                page,
              },
              false,
              ref,
            )
          : undefined;
      case 'filechooser':
        return this.add(
          event,
          from,
          {
            kind: 'upload',
            description: this.words.upload(
              element ? (fieldOf(element) ?? this.words.element) : this.words.element,
            ),
            page,
          },
          true,
        );
      case 'dialog':
        return this.add(
          event,
          from,
          { kind: 'dialog', description: this.words.dialog(event.dialog?.accepted ?? true), page },
          true,
        );
      default:
        return undefined;
    }
  }

  /** La valeur saisie (en mémoire seulement) : « Saisir "Alex" dans "Prénom" » ; jamais pour un champ sensible. */
  setTypedValue(rawEventId: string, value: string): LiveAction | undefined {
    const action = this.list.find((entry) => entry.rawEventIds.includes(rawEventId));
    if (!action || action.kind !== 'fill' || action.technical.sensitive === 'true') return undefined;
    const field = action.technical.field ?? this.words.element;
    action.description = value === '' ? this.words.fillNoValue(field) : this.words.fill(value, field);
    return action;
  }

  /** Le résultat de la validation immédiate d'un événement brut : ✓, ⚠ ou ✕. */
  onValidation(rawEventId: string, validation: RecordingTargetValidation): LiveAction | undefined {
    const action = this.list.find((entry) => entry.rawEventIds.includes(rawEventId));
    // Une validation d'un événement plus ancien que la dernière saisie du champ ne compte plus.
    if (!action || action.rawEventIds.at(-1) !== rawEventId) return undefined;
    const check = validation.validationAfter ?? validation.validationBefore;
    action.technical.validation = validation.status;
    action.facts.uniqueTarget = check.candidateCount <= 1 || validation.status !== 'AMBIGUOUS';
    // Le localisateur RETENU (rôle + nom, libellé…) : seul un CSS fragile ou une cible fragile compte.
    const target = validation.targetAfter ?? validation.targetBefore;
    action.facts.stableSelector =
      validation.status !== 'VALIDATED_FRAGILE' &&
      (target === undefined || target.strategy !== 'css' || action.facts.stableSelector);
    action.facts.afterRerender = validation.status === 'VALIDATED_AFTER_RERENDER';
    action.evidence.candidates = check.candidateCount;
    action.evidence.reason = check.reason;
    if (validation.effects && validation.effects.length > 0)
      action.evidence.effects = validation.effects.slice(0, 6);
    if (VALIDATED_STATUSES.has(validation.status)) {
      action.status = 'CONFIRMED';
      action.statusText =
        validation.status === 'VALIDATED_FRAGILE'
          ? this.words.confirmedFragile
          : validation.status === 'VALIDATED_AFTER_RERENDER'
            ? this.words.confirmedRerender
            : this.words.confirmed;
    } else if (validation.status === 'AMBIGUOUS') {
      const candidates = (check.candidates ?? []).map((candidate) => ({
        index: candidate.index,
        original: candidate.original,
        label: [
          candidate.name ?? candidate.role ?? this.words.element,
          candidate.section,
          this.words.position(candidate.index),
          candidate.original ? this.words.touched : undefined,
        ]
          .filter(Boolean)
          .join(' — '),
      }));
      // L'élément TOUCHÉ est toujours connu (l'enregistreur l'a capturé) : si la liste des
      // correspondances ne le désigne pas, il est proposé tel quel — l'humain a toujours de quoi valider.
      if (!candidates.some((candidate) => candidate.original))
        candidates.unshift({
          index: -1,
          original: true,
          label: this.words.touchedElement(
            action.technical.label ??
              action.technical.name ??
              action.technical.text ??
              action.technical.field ??
              this.words.element,
          ),
        });
      action.candidates = candidates;
      if (action.resolution) return action;
      action.status = 'AMBIGUOUS';
      action.statusText = this.words.ambiguous(Math.max(check.candidateCount, candidates.length, 2));
    } else if (validation.status === 'NOT_VALIDATABLE') {
      action.status = 'UNVERIFIED';
      action.statusText = this.words.unverified;
    } else {
      action.status = 'FAILED';
      action.statusText = this.words.failed;
    }
    return action;
  }

  /**
   * L'humain confirme l'élément d'une action ambiguë. Seul l'élément RÉELLEMENT touché peut être
   * confirmé : en choisir un autre enregistrerait une action jamais faite (refusé).
   */
  resolve(
    actionId: string,
    candidateIndex: number,
  ):
    | { action: LiveAction; candidate: LiveCandidate }
    | { error: 'NOT_FOUND' | 'NOT_AMBIGUOUS' | 'NOT_TOUCHED' } {
    const action = this.list.find((entry) => entry.id === actionId);
    if (!action) return { error: 'NOT_FOUND' };
    const candidate = action.candidates?.find((entry) => entry.index === candidateIndex);
    if (!candidate) return { error: 'NOT_AMBIGUOUS' };
    if (!candidate.original) return { error: 'NOT_TOUCHED' };
    action.resolution = 'RESOLVED';
    action.status = 'CONFIRMED';
    action.statusText = this.words.resolved;
    action.facts.uniqueTarget = true;
    action.technical.resolution = `USER_CONFIRMED candidate ${String(candidateIndex)}`;
    return { action, candidate };
  }

  /** L'humain laisse l'ambiguïté : elle reste visible (⚠), jamais résolue en silence. */
  ignore(actionId: string): LiveAction | undefined {
    const action = this.list.find((entry) => entry.id === actionId);
    if (action?.status !== 'AMBIGUOUS') return undefined;
    action.resolution = 'IGNORED';
    action.statusText = this.words.ignored;
    action.technical.resolution = 'USER_IGNORED';
    return action;
  }

  /**
   * Retire la dernière action : renvoie la plage de séquences brutes à retirer de l'enregistrement
   * (tout ce qui suit l'action d'avant : son bruit et les effets qu'elle a causés).
   */
  undoLast(): LiveAction | undefined {
    // La page d'ouverture n'est pas une action annulable.
    const last = this.list.at(-1);
    if (!last || last.kind === 'open') return undefined;
    this.list.pop();
    return last;
  }

  summary(): LiveSummary {
    const count = (status: LiveActionStatus): number =>
      this.list.filter((action) => action.status === status).length;
    const ambiguous = count('AMBIGUOUS');
    const failed = count('FAILED');
    return {
      actions: this.list.length,
      confirmed: count('CONFIRMED'),
      pending: count('PENDING'),
      ambiguous,
      failed,
      unverified: count('UNVERIFIED'),
      attention:
        this.list.filter((action) => action.status === 'AMBIGUOUS' && action.resolution !== 'IGNORED')
          .length + failed,
    };
  }

  /** La qualité, à partir des faits de chaque action (aucune estimation). */
  quality(): LiveQuality {
    const actions = this.list.filter((action) => action.kind !== 'open' && action.kind !== 'navigate');
    const settled = actions.filter((action) => action.status !== 'PENDING');
    const raw: Omit<QualityCheck, 'ok'>[] = [
      {
        id: 'confirmed',
        passed: settled.filter((action) => action.status === 'CONFIRMED').length,
        total: settled.length,
      },
      {
        id: 'stable',
        passed: settled.filter((action) => action.facts.stableSelector).length,
        total: settled.length,
      },
      {
        id: 'unique',
        passed: settled.filter((action) => action.facts.uniqueTarget).length,
        total: settled.length,
      },
      {
        id: 'rerender',
        passed: settled.filter((action) => !action.facts.afterRerender).length,
        total: settled.length,
      },
      {
        id: 'duplicates',
        passed: actions.filter((action) => action.facts.mergedEvents === 0).length,
        total: actions.length,
      },
      {
        id: 'errors',
        passed: settled.filter((action) => action.status !== 'FAILED').length,
        total: settled.length,
      },
    ];
    const checks: QualityCheck[] = raw.map((check) => ({ ...check, ok: check.passed === check.total }));
    // Les doublons fusionnés sont gérés (pas une faute) : la note compte confirmé, stable, unique, sans erreur.
    const scored = checks.filter((check) => ['confirmed', 'stable', 'unique', 'errors'].includes(check.id));
    const total = scored.reduce((sum, check) => sum + check.total, 0);
    const passed = scored.reduce((sum, check) => sum + check.passed, 0);
    return { ...(total > 0 ? { score: Math.round((passed / total) * 100) } : {}), checks };
  }

  private add(
    event: RawRecordedEvent,
    from: number,
    shape: { kind: LiveActionKind; description: string; detail?: string; page: string },
    immediate: boolean,
    ref?: string,
  ): LiveAction {
    this.counter += 1;
    const element = event.element;
    const action: LiveAction = {
      id: `l${String(this.counter)}`,
      index: this.list.length + 1,
      ...shape,
      status: immediate
        ? shape.kind === 'open' || shape.kind === 'navigate'
          ? 'CONFIRMED'
          : 'UNVERIFIED'
        : 'PENDING',
      statusText: immediate
        ? shape.kind === 'open' || shape.kind === 'navigate'
          ? this.words.opened
          : this.words.unverified
        : this.words.pending,
      rawEventIds: [event.id],
      fromSequence: from,
      lastSequence: event.sequence,
      ...(ref ? { ref } : {}),
      ...(element?.css ? { css: element.css } : {}),
      technical: technicalOf(event),
      evidence: {},
      facts: {
        stableSelector: element ? element.cssStable : true,
        uniqueTarget: true,
        afterRerender: false,
        mergedEvents: 0,
      },
      at: event.at,
    };
    if (!immediate && !this.validating) {
      action.status = 'UNVERIFIED';
      action.statusText = this.words.unverified;
    }
    this.list.push(action);
    return action;
  }

  private extend(action: LiveAction, event: RawRecordedEvent, ref?: string): void {
    action.rawEventIds.push(event.id);
    action.lastSequence = event.sequence;
    if (event.type === 'input' || event.type === 'change') action.facts.mergedEvents += 1;
    if (ref) action.ref = ref;
  }

  private pending(action: LiveAction): void {
    if (!this.validating) return;
    action.status = 'PENDING';
    action.statusText = this.words.pending;
  }
}

function routeOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

function clean(text: string | undefined): string | undefined {
  const value = text?.replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 80) : undefined;
}

function nameOf(element: RecordedElement): string | undefined {
  return clean(element.name) ?? clean(element.text) ?? clean(element.label);
}

function fieldOf(element: RecordedElement): string | undefined {
  return (
    clean(element.label) ??
    clean(element.name) ??
    clean(element.guessedLabel) ??
    clean(element.placeholder) ??
    clean(element.formControlName) ??
    clean(element.nameAttr)
  );
}

function isToggle(element: RecordedElement): boolean {
  return (
    element.inputType === 'checkbox' ||
    element.inputType === 'radio' ||
    element.role === 'checkbox' ||
    element.role === 'radio' ||
    element.role === 'switch'
  );
}

/** Les détails techniques d'un événement : type, sélecteur, rôle, texte, page — jamais une valeur saisie. */
function technicalOf(event: RawRecordedEvent): Record<string, string> {
  const element = event.element;
  const entries: [string, string | undefined][] = [
    ['event', event.type],
    ['rawEventId', event.id],
    ['page', routeOf(event.url)],
    ['frame', 'main'],
    ['selector', element?.css],
    ['role', element?.role],
    ['tag', element?.tag],
    ['name', clean(element?.name)],
    ['text', clean(element?.text)],
    ['label', clean(element?.label)],
    ['section', element?.sectionPath?.join(' > ')],
    [
      'matches',
      element && element.sameRoleName > 1
        ? `${String(element.sameRoleName)} (index ${String(element.roleNameIndex)})`
        : undefined,
    ],
    ['shadowDom', element?.inShadow ? 'true' : undefined],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''),
  );
}
