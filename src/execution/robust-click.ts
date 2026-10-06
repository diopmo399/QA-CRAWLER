import type { Locator } from 'playwright';

/**
 * ROBUST CLICK — cliquer comme un humain quand l'habillage du contrôle « recouvre » sa propre cible.
 *
 * Playwright refuse un clic tant qu'un autre élément reçoit le pointeur au point visé
 * (« <input> intercepts pointer events ») et réessaie jusqu'au délai. C'est juste pour un VRAI
 * obstacle (fenêtre, fond, chargeur) ; c'est faux quand l'élément au-dessus est le CONTRÔLE DE LA CIBLE
 * elle-même : l'input natif invisible d'un radio posé sur son libellé, la case dessinée d'une checkbox.
 * Un humain clique au même endroit : l'événement atteint ce contrôle, l'option est choisie.
 *
 *  1. essai (trial) : la cible est-elle actionnable ? → clic normal ;
 *  2. sinon, DIAGNOSTIC au centre de la cible : SELF / OWN_CONTROL / FOREIGN / NONE ;
 *  3. OWN_CONTROL → clic au même endroit (force) ; un libellé de radio / case non coché ensuite :
 *     clic du contrôle lui-même ;
 *  4. FOREIGN ou NONE → le clic normal attend, jusqu'au délai (un vrai obstacle n'est JAMAIS forcé) ;
 *     l'erreur dit ce qui recouvre la cible.
 */
export interface ClickDiagnosis {
  target: string;
  /** Ce qui reçoit le pointeur au centre de la cible (shadow roots traversés). */
  onTop: string;
  relation: 'SELF' | 'OWN_CONTROL' | 'FOREIGN' | 'NONE';
  /** Le contrôle associé (libellé → input), s'il y en a un. */
  control?: string;
  inViewport: boolean;
}

const TRIAL_MS = 1500;

export async function diagnoseClick(locator: Locator): Promise<ClickDiagnosis | undefined> {
  return locator
    .evaluate((el) => {
      const describe = (node: Element | null): string => {
        if (!node) return '(nothing)';
        const id = node.id ? `#${node.id}` : '';
        const typeName = node.getAttribute('type');
        const type = typeName ? `[type=${typeName}]` : '';
        const name = node.getAttribute('formcontrolname') ?? node.getAttribute('name');
        const text = node.textContent.replace(/\s+/g, ' ').trim().slice(0, 30);
        return `<${node.tagName.toLowerCase()}${id}${type}${name ? ` name=${name}` : ''}>${text ? ` "${text}"` : ''}`;
      };
      const within = (outer: Element, inner: Element): boolean => {
        let current: Node | null = inner;
        while (current) {
          if (current === outer) return true;
          current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
        }
        return false;
      };
      // Le contrôle de la cible : label.control, sinon l'unique champ de l'enveloppe (≤ 4 niveaux).
      const control = ((): Element | null => {
        if (el.tagName === 'LABEL' && (el as HTMLLabelElement).control)
          return (el as HTMLLabelElement).control;
        let node: Element | null = el.parentElement;
        for (
          let depth = 0;
          node && node !== document.body && depth < 4;
          depth += 1, node = node.parentElement
        ) {
          const fields = node.querySelectorAll('input:not([type="hidden"]), select, textarea');
          if (fields.length > 1) return null;
          if (fields.length === 1) return fields[0] ?? null;
        }
        return null;
      })();
      const box = el.getBoundingClientRect();
      const inViewport =
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < innerHeight &&
        box.left < innerWidth;
      let top: Element | null = null;
      if (inViewport) {
        top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        while (top?.shadowRoot) {
          const inner = top.shadowRoot.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          if (!inner || inner === top) break;
          top = inner;
        }
      }
      const relation: ClickDiagnosis['relation'] = !top
        ? 'NONE'
        : top === el || within(el, top)
          ? 'SELF'
          : control && (top === control || within(control, top) || within(top, control))
            ? 'OWN_CONTROL'
            : 'FOREIGN';
      return {
        target: describe(el),
        onTop: describe(top),
        relation,
        ...(control ? { control: describe(control) } : {}),
        inViewport,
      };
    })
    .catch(() => undefined);
}

/** Les lignes utiles du journal d'appel de Playwright (ce qu'il attendait, ce qui interceptait). */
export function playwrightCallLog(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /intercepts pointer events|not visible|not stable|not enabled|outside of the viewport|waiting for/i.test(
        line,
      ),
    )
    .slice(-4);
}

export async function clickRobust(
  locator: Locator,
  timeoutMs: number,
  debug?: (line: string) => void,
): Promise<void> {
  const started = Date.now();
  try {
    await locator.click({ trial: true, timeout: Math.min(timeoutMs, TRIAL_MS) });
    debug?.('click: target actionable — normal click');
    await locator.click({ timeout: timeoutMs });
    return;
  } catch (trialError) {
    const diagnosis = await diagnoseClick(locator);
    debug?.(
      `click: not actionable after ${String(Date.now() - started)} ms — target ${diagnosis?.target ?? '?'}, on top ${diagnosis?.onTop ?? '?'} (${diagnosis?.relation ?? 'UNKNOWN'})${diagnosis?.control ? `, own control ${diagnosis.control}` : ''}`,
    );
    for (const line of playwrightCallLog(trialError)) debug?.(`click: playwright: ${line}`);
    if (diagnosis?.relation === 'OWN_CONTROL') {
      // Le pointeur tombe sur le contrôle de la cible : le clic d'un humain au même endroit.
      debug?.('click: the element on top is the target’s own control — clicking at the same point (force)');
      await locator.click({ force: true, timeout: Math.max(1000, timeoutMs - (Date.now() - started)) });
      const unchecked = await locator
        .evaluate((el) => {
          const control =
            el.tagName === 'LABEL' ? ((el as HTMLLabelElement).control as HTMLInputElement | null) : null;
          if (!control || !['radio', 'checkbox'].includes(control.type) || control.checked) return false;
          control.click();
          return true;
        })
        .catch(() => false);
      if (unchecked) debug?.('click: the option was still unselected — its own control clicked');
      return;
    }
    // Un vrai obstacle (ou rien d'identifiable) : attendre comme avant, jamais forcer.
    try {
      await locator.click({ timeout: Math.max(500, timeoutMs - (Date.now() - started)) });
      debug?.('click: obstacle gone — normal click');
    } catch (error) {
      const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'click failed';
      const obstacle = diagnosis ? ` — on top of the target: ${diagnosis.onTop} (${diagnosis.relation})` : '';
      throw new Error(`${first}${obstacle}`, { cause: error });
    }
  }
}
