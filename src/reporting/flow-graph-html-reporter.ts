import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../model/exploration-result.js';
import { buildFlowTree, displayName, renderTextTree } from './flow-tree.js';
import { BASE_CSS, card, classPill, esc, renderTreeHtml } from './html-common.js';
import type { Reporter } from './reporter.js';

/** reports/flow-graph.html — the functional map: tree, states and every transition. */
export class FlowGraphHtmlReporter implements Reporter {
  readonly format = 'flow-graph-html';

  constructor(
    private readonly directory: string,
    private readonly fileName = 'flow-graph.html',
  ) {}

  async write(result: ExplorationResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    await writeFile(target, renderFlowGraphHtml(result), 'utf8');
    return target;
  }
}

export function renderFlowGraphHtml(result: ExplorationResult): string {
  const tree = buildFlowTree(result.states, result.transitions, result.states[0]?.id);
  const name = new Map(result.states.map((state) => [state.id, displayName(state)]));
  const nameOf = (id: string): string => name.get(id) ?? id;
  const moves = result.transitions.filter((edge) => edge.result === 'SUCCESS' && edge.from !== edge.to);
  const others = result.transitions.filter((edge) => !(edge.result === 'SUCCESS' && edge.from !== edge.to));

  const edgeRow = (edge: ExplorationResult['transitions'][number]): string =>
    `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(edge.action.type)} “${esc(edge.action.text ?? edge.action.label ?? '')}” ${classPill(edge.action.classification)}</td><td>${edge.from === edge.to ? '<span class="muted">(same state)</span>' : `<b>${esc(nameOf(edge.to))}</b>`}</td><td>${classPill(edge.result)}${edge.reason ? ` <span class="muted">${esc(edge.reason)}</span>` : ''}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flow graph — ${esc(result.mission)}</title>
<style>${BASE_CSS} pre.tree-text { background:#0f172a; color:#e2e8f0; padding:14px; border-radius:8px; overflow-x:auto; font-size:12px; }</style>
</head>
<body>
<header>
  <h1>Flow graph — ${esc(result.mission)}</h1>
  <div class="meta">${esc(result.target.startUrl)}</div>
  <nav><a href="index.html">← Report</a><a href="flow-graph.json">flow-graph.json</a></nav>
</header>
<main>
  <div class="cards">
    ${card('States', result.stats.states)}
    ${card('Transitions', moves.length)}
    ${card('Blocked', result.stats.actionsBlocked)}
    ${card('Failed', result.stats.actionsFailed)}
    ${card('Max depth', result.stats.maxDepth)}
  </div>
  <section><h2>Application map</h2>${renderTreeHtml(tree, (stateId) => result.issues.filter((issue) => issue.states.includes(stateId)).length)}</section>
  <section><h2>Text view</h2><pre class="tree-text">${esc(renderTextTree(tree))}</pre></section>
  <section><h2>Transitions between states (${moves.length})</h2>
    <table><thead><tr><th>From</th><th>Action</th><th>To</th><th>Result</th></tr></thead><tbody>${moves.map(edgeRow).join('')}</tbody></table>
  </section>
  <section><h2>Other attempts (${others.length})</h2>
    <p class="muted">Actions without visible effect, failed or blocked by the safety policy.</p>
    <table><thead><tr><th>From</th><th>Action</th><th>To</th><th>Result</th></tr></thead><tbody>${others.map(edgeRow).join('')}</tbody></table>
  </section>
</main>
</body>
</html>
`;
}
