import { SIMULATION_ENVIRONMENT_KINDS, type ExecutionDetail } from '../core/contracts.js';
import type { JourneyPreview, PreviewInput, PreviewStep } from '../core/journey-loop.js';
import { pathLetter } from '../core/journey.js';
import { icon, pill } from './dashboard-parts.js';
import { dataTraceHtml, loopIterationsHtml } from './dashboard-trace.js';
import type { DashboardState } from './dashboard-view.js';
import { esc } from './view.js';

/**
 * LA SIMULATION DANS LE COMPOSITEUR, en deux temps clairement séparés :
 *   1. l'APERÇU (simulation statique) : la vérification et la provenance de chaque donnée, sans rien exécuter ;
 *   2. l'EXÉCUTION DE SIMULATION : un vrai rejeu du moteur, seulement dans un environnement de développement
 *      ou de test choisi explicitement ; ses résultats (itérations, valeurs, traces) sont réels.
 * Jamais un résultat d'aperçu n'est présenté comme exécuté, ni une valeur générée comme connue d'avance.
 */

export interface SimulationUi {
  env?: string;
  path: number;
  previewBusy?: boolean;
  preview?: JourneyPreview;
  previewError?: string;
  running?: boolean;
  run?: string;
  status?: string;
  detail?: ExecutionDetail;
  error?: string;
}

const FR = {
  tab: 'Simulation',
  previewTitle: 'Aperçu — simulation statique',
  previewNote: 'Rien n’est exécuté : la provenance de chaque donnée, d’après les contrats des blocs.',
  previewDo: 'Calculer l’aperçu',
  previewBusy: 'Calcul…',
  previewStale: 'Le parcours a changé depuis cet aperçu : recalculez-le.',
  runTitle: 'Exécution de simulation — réelle',
  runNote:
    'Exécute réellement les blocs avec le moteur, dans un environnement isolé (développement ou test). Le parcours n’est pas enregistré comme scénario.',
  env: 'Environnement isolé',
  envPick: 'Choisir…',
  envRefused: (kind: string) => `${kind} : refusé (non isolé)`,
  envNone: 'Aucun environnement de développement ou de test : créez-en un dans Environnements.',
  path: 'Chemin',
  runDo: 'Exécuter la simulation',
  running: 'Exécution réelle en cours…',
  runDone: 'Résultats réels de l’exécution',
  openRun: 'Ouvrir l’exécution',
  colStep: 'Étape',
  colInputs: 'Entrées (provenance)',
  colOutputs: 'Sorties',
  sources: {
    UPSTREAM: 'bloc précédent',
    DATA: 'jeu du bloc',
    VALUE: 'saisie dans le parcours',
    LOOP: 'variable d’itération',
    MISSING: 'manquante',
  } as Record<string, string>,
  statuses: {
    KNOWN: 'connue',
    AT_RUN: 'connue à l’exécution',
    MISSING: 'manquante',
    SECRET: 'secrète',
  } as Record<string, string>,
  scopes: { RUN: 'toute l’exécution', ITERATION: 'une itération' } as Record<string, string>,
  loopInfo: (iterations: number | undefined, max: number, timeout: number) =>
    `${iterations === undefined ? 'nombre d’itérations connu à l’exécution' : `${String(iterations)} itération(s)`} · plafond ${String(max)} · ${String(timeout)} s`,
  values: 'valeurs',
  none: '—',
  previewOk: 'Le parcours est valide.',
  previewKo: (count: number) => `${String(count)} erreur(s) : la simulation ne peut pas s’exécuter.`,
  verdicts: {
    PASSED: 'Réussie',
    FAILED: 'Échouée',
    INCOMPLETE: 'Incomplète',
    CANCELLED: 'Annulée',
  } as Record<string, string>,
  results: {
    PASSED: 'Réussie',
    FAILED: 'Échouée',
    BLOCKED: 'Bloquée',
    SKIPPED: 'Ignorée',
    MANUAL: 'Manuelle',
  } as Record<string, string>,
  saveFirst: 'Vérifiez le parcours d’abord.',
};
type Text = typeof FR;
const EN: Text = {
  tab: 'Simulation',
  previewTitle: 'Preview — static simulation',
  previewNote: 'Nothing is executed: where each data comes from, according to the block contracts.',
  previewDo: 'Compute the preview',
  previewBusy: 'Computing…',
  previewStale: 'The journey changed since this preview: compute it again.',
  runTitle: 'Simulation run — real',
  runNote:
    'Really executes the blocks with the engine, in an isolated environment (development or test). The journey is not saved as a scenario.',
  env: 'Isolated environment',
  envPick: 'Choose…',
  envRefused: (kind) => `${kind}: refused (not isolated)`,
  envNone: 'No development or test environment: create one in Environments.',
  path: 'Path',
  runDo: 'Run the simulation',
  running: 'Real run in progress…',
  runDone: 'Real results of the run',
  openRun: 'Open the run',
  colStep: 'Step',
  colInputs: 'Inputs (provenance)',
  colOutputs: 'Outputs',
  sources: {
    UPSTREAM: 'previous block',
    DATA: 'block data',
    VALUE: 'typed in the journey',
    LOOP: 'iteration variable',
    MISSING: 'missing',
  },
  statuses: { KNOWN: 'known', AT_RUN: 'known at run', MISSING: 'missing', SECRET: 'secret' },
  scopes: { RUN: 'whole run', ITERATION: 'one iteration' },
  loopInfo: (iterations, max, timeout) =>
    `${iterations === undefined ? 'iteration count known at run' : `${String(iterations)} iteration(s)`} · cap ${String(max)} · ${String(timeout)} s`,
  values: 'values',
  none: '—',
  previewOk: 'The journey is valid.',
  previewKo: (count) => `${String(count)} error(s): the simulation cannot run.`,
  verdicts: { PASSED: 'Passed', FAILED: 'Failed', INCOMPLETE: 'Incomplete', CANCELLED: 'Cancelled' },
  results: { PASSED: 'Passed', FAILED: 'Failed', BLOCKED: 'Blocked', SKIPPED: 'Skipped', MANUAL: 'Manual' },
  saveFirst: 'Check the journey first.',
};
export const simText = (state: DashboardState): Text => (state.t.locale === 'en' ? EN : FR);

function inputLine(t: Text, input: PreviewInput): string {
  const tone = input.status === 'MISSING' ? 'ko' : input.status === 'KNOWN' ? 'ok' : 'info';
  return `<li><code class="lib-key">${esc(input.key)}</code> ← <span>${esc(t.sources[input.source] ?? input.source)}${input.from && input.from !== 'loop' ? ` (${esc(input.from)})` : ''}${input.reads && input.reads !== input.key ? ` <code class="lib-key">${esc(input.reads)}</code>` : ''}</span> <span class="jn-chip ${tone}">${esc(t.statuses[input.status] ?? input.status)}</span>${input.value !== undefined ? ` <span class="tr-v">« ${esc(input.value)} »</span>` : ''}</li>`;
}

function stepRow(t: Text, step: PreviewStep, index: number): string {
  const label = `${step.depth > 0 ? '<span class="sim-indent" aria-hidden="true">↳</span>' : ''}<b>${esc(step.label)}</b>${step.version !== undefined ? ` <small class="mu">v${String(step.version)}</small>` : ''}`;
  const loop = step.loop
    ? `<div class="sim-loopinfo"><small>${esc(t.loopInfo(step.loop.iterations, step.loop.maxIterations, step.loop.timeoutS))}</small><ul class="plain">${step.loop.variables.map((variable) => `<li><code class="lib-key">${esc(variable.key)}</code> ${variable.values ? `<small class="mu">${esc(t.values)} :</small> ${variable.values.map((value) => `<span class="tr-v">${esc(value)}</span>`).join(', ')}` : `<span class="jn-chip info">${esc(t.statuses.AT_RUN ?? '')}</span>`}</li>`).join('')}</ul></div>`
    : '';
  const inputs =
    step.inputs.length > 0
      ? `<ul class="plain sim-io">${step.inputs.map((input) => inputLine(t, input)).join('')}</ul>`
      : step.wait
        ? `<small class="mu">${esc(step.wait)}</small>`
        : `<small class="mu">${esc(t.none)}</small>`;
  const outputs =
    step.outputs.length > 0
      ? `<ul class="plain sim-io">${step.outputs.map((output) => `<li><code class="lib-key">${esc(output.key)}</code> <small class="mu">${esc(output.origin)} · ${esc(t.scopes[output.scope] ?? output.scope)}</small> <span class="jn-chip ${output.status === 'KNOWN' ? 'ok' : 'info'}">${esc(t.statuses[output.status] ?? output.status)}</span>${output.value !== undefined ? ` <span class="tr-v">« ${esc(output.value)} »</span>` : ''}</li>`).join('')}</ul>`
      : `<small class="mu">${esc(t.none)}</small>`;
  return `<tr class="sim-${step.kind.toLowerCase()}${step.errors.length > 0 ? ' ko' : ''}"><td>${String(index + 1)}</td><td>${label}${loop}${step.errors.map((error) => `<small class="why">${esc(error)}</small>`).join('')}</td><td>${inputs}</td><td>${outputs}</td></tr>`;
}

/** Le contenu de l'onglet Simulation du panneau bas du compositeur. */
export function simulationPanel(state: DashboardState, publish: boolean, stale: boolean): string {
  const t = simText(state);
  const ui = state.lib.journey;
  const sim: SimulationUi = ui.sim ?? { path: 0 };
  const preview = sim.preview;
  const previewBody = preview
    ? `${stale ? `<p class="notice warn">${icon('info')}<span>${esc(t.previewStale)}</span></p>` : ''}<p class="${preview.ok ? 'ok-t' : 'err'}">${icon(preview.ok ? 'check' : 'alert')} ${esc(preview.ok ? t.previewOk : t.previewKo(preview.errors.length))}</p>${preview.paths
        .map(
          (path) =>
            `${preview.paths.length > 1 ? `<h5>${esc(t.path)} ${esc(pathLetter(path.index))}${path.choices.length > 0 ? ` <small class="mu">${esc(path.choices.map((choice) => `${choice.label} = ${choice.branch}`).join(', '))}</small>` : ''}</h5>` : ''}<div class="jn-tbl-w"><table class="jn-tbl sim-tbl"><thead><tr><th scope="col">#</th><th scope="col">${esc(t.colStep)}</th><th scope="col">${esc(t.colInputs)}</th><th scope="col">${esc(t.colOutputs)}</th></tr></thead><tbody>${path.steps.map((step, index) => stepRow(t, step, index)).join('')}</tbody></table></div>`,
        )
        .join('')}`
    : sim.previewError
      ? `<p class="err" role="alert">${esc(sim.previewError)}</p>`
      : '';
  const environments = state.project?.environments ?? [];
  const isolated = environments.filter((env) =>
    SIMULATION_ENVIRONMENT_KINDS.some((kind) => kind === env.kind),
  );
  const others = environments.filter((env) => !isolated.includes(env));
  const paths = preview?.paths ?? [];
  const envSelect =
    isolated.length === 0
      ? `<p class="mu">${esc(t.envNone)}</p>`
      : `<label class="field"><span>${esc(t.env)}</span><select data-jn="sim.env"><option value="">${esc(t.envPick)}</option>${isolated.map((env) => `<option value="${esc(env.id)}"${sim.env === env.id ? ' selected' : ''}>${esc(env.name)} · ${esc(env.kind)}</option>`).join('')}${others.map((env) => `<option disabled>${esc(env.name)} · ${esc(t.envRefused(env.kind))}</option>`).join('')}</select></label>`;
  const pathSelect =
    paths.length > 1
      ? `<label class="field"><span>${esc(t.path)}</span><select data-jn="sim.path">${paths.map((path) => `<option value="${String(path.index)}"${sim.path === path.index ? ' selected' : ''}>${esc(pathLetter(path.index))}</option>`).join('')}</select></label>`
      : '';
  const canRun = publish && Boolean(sim.env) && !sim.running && isolated.some((env) => env.id === sim.env);
  const detail = sim.detail;
  const result = sim.running
    ? `<p role="status" class="live"><span class="spin" aria-hidden="true"></span> ${esc(t.running)}${sim.status ? ` <small class="mu">(${esc(sim.status)})</small>` : ''}</p>`
    : detail
      ? `<section class="sim-result" aria-labelledby="sim-res-t"><h5 id="sim-res-t">${esc(t.runDone)} ${pill(detail.verdict, t.verdicts[detail.verdict] ?? detail.verdict)} <button type="button" class="lnk" data-action="open-run" data-project="${esc(detail.projectId)}" data-run="${esc(detail.run)}">${esc(t.openRun)}</button></h5>${detail.flowsDetail
          .map(
            (flow) =>
              `<ol class="steps">${flow.steps.map((step) => `<li>${pill(step.status, t.results[step.status] ?? step.status)}<span>${String(step.index)}. ${esc(step.label)}</span>${step.reason ? `<small class="why">${esc(step.reason)}</small>` : ''}${loopIterationsHtml(state.t.locale, step, t.results)}</li>`).join('')}</ol>${dataTraceHtml(state.t.locale, flow)}`,
          )
          .join('')}</section>`
      : sim.error
        ? `<p class="err" role="alert">${esc(sim.error)}</p>`
        : '';
  return `<div class="sim-grid"><section class="sim-box static" aria-labelledby="sim-prev-t"><h4 id="sim-prev-t">${icon('search')}<span>${esc(t.previewTitle)}</span></h4><p class="mu small">${esc(t.previewNote)}</p><div class="form-acts start"><button type="button" class="btn small" data-action="jn-preview"${sim.previewBusy ? ' disabled' : ''} aria-busy="${String(Boolean(sim.previewBusy))}">${esc(sim.previewBusy ? t.previewBusy : t.previewDo)}</button></div>${previewBody}</section><section class="sim-box real" aria-labelledby="sim-run-t"><h4 id="sim-run-t">${icon('play')}<span>${esc(t.runTitle)}</span></h4><p class="mu small">${esc(t.runNote)}</p>${publish ? `<div class="jn-row2">${envSelect}${pathSelect}</div><div class="form-acts start"><button type="button" class="btn small primary" data-action="jn-simulate"${canRun ? '' : ' disabled'}>${icon('play')}<span>${esc(t.runDo)}</span></button></div>` : ''}${result}</section></div>`;
}

export const SIM_CSS = `
.sim-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.sim-box{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;min-width:0}
.sim-box h4{display:flex;align-items:center;gap:6px;margin:0 0 4px;font-size:13px}
.sim-box.static{border-style:dashed}
.sim-box.real{border-color:color-mix(in srgb,var(--qa-color-primary) 45%,var(--qa-color-border))}
.sim-tbl td{vertical-align:top;font-size:12px}
.sim-io{display:flex;flex-direction:column;gap:2px}
.sim-indent{color:#7C3AED;margin-right:4px}
.sim-loopinfo{margin-top:4px;padding-left:8px;border-left:2px solid color-mix(in srgb,#7C3AED 45%,transparent)}
.sim-tbl tr.sim-loop td:first-child,.sim-tbl tr.sim-loop{background:color-mix(in srgb,#7C3AED 5%,transparent)}
.sim-result h5{display:flex;align-items:center;gap:8px;margin:8px 0 4px;font-size:13px}
`;
