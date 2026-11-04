import type { ExecutionDataTraceView, ExecutionFlowView, ExecutionStepView } from '../core/contracts.js';
import { pill } from './dashboard-parts.js';
import { esc } from './view.js';

/**
 * LA TRAÇABILITÉ D'UNE EXÉCUTION RÉELLE : les itérations de chaque boucle (variables, étapes, statut, raison
 * d'arrêt) et la trace des données (valeur produite ou lue, par quel bloc, à quelle étape, à quelle
 * itération). Tout vient du rapport du moteur : rien n'est estimé ni reconstitué.
 */

const FR = {
  iterations: (count: number, planned?: number) =>
    `${String(count)} itération(s)${planned !== undefined ? ` sur ${String(planned)} prévue(s)` : ''}`,
  iteration: (index: number) => `Itération ${String(index)}`,
  stops: {
    COMPLETED: 'terminée',
    CONDITION_FALSE: 'condition devenue fausse (arrêt normal)',
    MAX_ITERATIONS: 'plafond atteint (protection contre la boucle infinie)',
    TIMEOUT: 'délai global dépassé',
    FAILED: 'arrêtée après un échec',
    REFUSED: 'refusée avant de commencer',
  } as Record<string, string>,
  stop: 'Arrêt',
  limits: (max: number, timeout: number, policy: string) =>
    `plafond ${String(max)} · délai ${String(Math.round(timeout / 1000))} s · ${policy === 'CONTINUE' ? 'continuer après un échec' : 'arrêter au premier échec'}`,
  variables: 'Variables',
  traceTitle: 'Traçabilité des données',
  traceSub: 'Valeurs réellement produites et lues pendant cette exécution (clés sensibles masquées).',
  colKey: 'Donnée',
  colOrigin: 'Origine',
  colValue: 'Valeur',
  colBlock: 'Bloc',
  colStep: 'Étape',
  colIteration: 'Itération',
  origins: {
    GENERATED: 'Générée',
    CAPTURED: 'Capturée',
    ITERATION: 'Variable d’itération',
    USED: 'Lue',
  } as Record<string, string>,
  masked: 'masquée',
  none: '—',
  traceNone: 'Aucune donnée produite ou lue n’a été rapportée.',
  history: 'Historique des valeurs',
  producers: 'Producteurs et consommateurs',
  producedBy: (blocks: string) => `produite par ${blocks}`,
  readBy: (blocks: string) => `lue par ${blocks}`,
};
type Text = typeof FR;
const EN: Text = {
  iterations: (count, planned) =>
    `${String(count)} iteration(s)${planned !== undefined ? ` of ${String(planned)} planned` : ''}`,
  iteration: (index) => `Iteration ${String(index)}`,
  stops: {
    COMPLETED: 'completed',
    CONDITION_FALSE: 'condition became false (normal stop)',
    MAX_ITERATIONS: 'cap reached (infinite loop protection)',
    TIMEOUT: 'global timeout exceeded',
    FAILED: 'stopped after a failure',
    REFUSED: 'refused before starting',
  },
  stop: 'Stop',
  limits: (max, timeout, policy) =>
    `cap ${String(max)} · timeout ${String(Math.round(timeout / 1000))} s · ${policy === 'CONTINUE' ? 'continue after a failure' : 'stop at the first failure'}`,
  variables: 'Variables',
  traceTitle: 'Data traceability',
  traceSub: 'Values really produced and read during this run (sensitive keys masked).',
  colKey: 'Data',
  colOrigin: 'Origin',
  colValue: 'Value',
  colBlock: 'Block',
  colStep: 'Step',
  colIteration: 'Iteration',
  origins: { GENERATED: 'Generated', CAPTURED: 'Captured', ITERATION: 'Iteration variable', USED: 'Read' },
  masked: 'masked',
  none: '—',
  traceNone: 'No produced or read data was reported.',
  history: 'Value history',
  producers: 'Producers and consumers',
  producedBy: (blocks) => `produced by ${blocks}`,
  readBy: (blocks) => `read by ${blocks}`,
};
export const traceText = (locale: string): Text => (locale === 'en' ? EN : FR);

/** Les itérations réelles d'une étape `loop` (rien si l'étape n'est pas une boucle). */
export function loopIterationsHtml(
  locale: string,
  step: ExecutionStepView,
  results: Record<string, string>,
): string {
  const loop = step.loop;
  if (!loop) return '';
  const t = traceText(locale);
  const iterations = loop.iterations
    .map(
      (iteration) =>
        `<li class="tr-it"><details${iteration.status === 'PASSED' ? '' : ' open'}><summary>${pill(iteration.status, results[iteration.status] ?? iteration.status)} <b>${esc(t.iteration(iteration.iteration))}</b>${iteration.variables.length > 0 ? ` <span class="tr-vars">${iteration.variables.map((variable) => `<code class="lib-key">${esc(variable.key)}</code>${variable.value === undefined ? ` <small class="mu">${esc(t.masked)}</small>` : ` = <span class="tr-v">${esc(variable.value)}</span>`}`).join(' ')}</span>` : ''}</summary><ol class="steps tr-steps">${iteration.steps.map((inner) => `<li>${pill(inner.status, results[inner.status] ?? inner.status)}<span>${String(inner.index)}. ${esc(inner.label)}</span>${inner.reason ? `<small class="why">${esc(inner.reason)}</small>` : ''}${loopIterationsHtml(locale, inner, results)}</li>`).join('')}</ol>${iteration.reason ? `<p class="why">${esc(iteration.reason)}</p>` : ''}</details></li>`,
    )
    .join('');
  return `<div class="tr-loop"><p class="tr-loop-h"><b>${esc(t.iterations(loop.iterations.length, loop.planned))}</b> · ${esc(t.stop)} : ${esc(t.stops[loop.stop] ?? loop.stop)} <small class="mu">(${esc(t.limits(loop.maxIterations, loop.timeoutMs, loop.onFailure))})</small></p><ol class="plain tr-its">${iterations}</ol></div>`;
}

const iterationOf = (entry: ExecutionDataTraceView): string =>
  entry.loops && entry.loops.length > 0
    ? entry.loops.map((loop) => `${loop.id} #${String(loop.iteration)}`).join(' › ')
    : '';

/** La trace des données d'un flow : un tableau, puis producteurs et consommateurs par donnée. */
export function dataTraceHtml(locale: string, flow: ExecutionFlowView): string {
  const t = traceText(locale);
  const trace = flow.dataTrace ?? [];
  if (trace.length === 0) return `<p class="mu">${esc(t.traceNone)}</p>`;
  const rows = trace
    .map(
      (entry) =>
        `<tr class="tr-${entry.origin.toLowerCase()}"><td><code class="lib-key">${esc(entry.key)}</code></td><td><span class="tr-o ${entry.origin.toLowerCase()}">${esc(t.origins[entry.origin] ?? entry.origin)}</span></td><td>${entry.masked ? `<small class="mu">${esc(t.masked)}</small>` : entry.value !== undefined ? `<span class="tr-v">${esc(entry.value)}</span>` : esc(t.none)}</td><td>${esc(entry.block ?? t.none)}</td><td>${entry.step !== undefined ? `${String(entry.step)}${entry.stepName ? ` <small class="mu">${esc(entry.stepName.split(' › ').at(-1) ?? '')}</small>` : ''}` : esc(t.none)}</td><td>${esc(iterationOf(entry) || t.none)}</td></tr>`,
    )
    .join('');
  const keys = [...new Set(trace.filter((entry) => entry.origin !== 'ITERATION').map((entry) => entry.key))];
  const flowLines = keys
    .map((key) => {
      const producers = [
        ...new Set(
          trace
            .filter(
              (entry) => entry.key === key && (entry.origin === 'GENERATED' || entry.origin === 'CAPTURED'),
            )
            .map((entry) => entry.block ?? flow.name),
        ),
      ];
      const readers = [
        ...new Set(
          trace
            .filter((entry) => entry.key === key && entry.origin === 'USED')
            .map((entry) => entry.block ?? flow.name),
        ),
      ];
      if (producers.length === 0 && readers.length === 0) return '';
      return `<li><code class="lib-key">${esc(key)}</code> ${producers.length > 0 ? `<span>${esc(t.producedBy(producers.join(', ')))}</span>` : ''}${producers.length > 0 && readers.length > 0 ? ' → ' : ''}${readers.length > 0 ? `<span>${esc(t.readBy(readers.join(', ')))}</span>` : ''}</li>`;
    })
    .join('');
  return `<div class="tr-trace"><p class="mu small">${esc(t.traceSub)}</p>${flowLines ? `<h4>${esc(t.producers)}</h4><ul class="plain tr-flow">${flowLines}</ul>` : ''}<h4>${esc(t.history)}</h4><div class="tw"><table class="tbl tr-tbl"><thead><tr><th scope="col">${esc(t.colKey)}</th><th scope="col">${esc(t.colOrigin)}</th><th scope="col">${esc(t.colValue)}</th><th scope="col">${esc(t.colBlock)}</th><th scope="col">${esc(t.colStep)}</th><th scope="col">${esc(t.colIteration)}</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

export const TRACE_CSS = `
.steps li>.tr-loop{grid-column:1 / -1}
.tr-loop{margin:6px 0 2px 22px;padding-left:10px;border-left:2px solid color-mix(in srgb,#7C3AED 45%,transparent)}
.tr-loop-h{margin:0 0 4px;font-size:12px}
.tr-its{display:flex;flex-direction:column;gap:4px}
.tr-it summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px}
.tr-vars{display:inline-flex;flex-wrap:wrap;gap:6px;align-items:center}
.tr-v{font-family:var(--qa-font-mono,ui-monospace,monospace);font-size:12px;word-break:break-all}
.tr-steps{margin:4px 0 4px 14px}
.tr-steps li{padding:6px 0}
.tr-trace h4{margin:10px 0 4px;font-size:13px}
.tr-flow{display:flex;flex-direction:column;gap:3px;font-size:12px}
.tr-o{display:inline-block;padding:0 6px;border-radius:999px;font-size:11px;border:1px solid var(--qa-color-border)}
.tr-o.generated{color:var(--qa-color-primary-2);background:var(--qa-color-primary-soft)}
.tr-o.captured{color:var(--qa-color-data,#2F7DE1);border-color:currentColor}
.tr-o.iteration{color:#7C3AED;border-color:currentColor}
.tr-o.used{color:var(--qa-color-muted)}
.tr-tbl td{vertical-align:top}
`;
