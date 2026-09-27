import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../model/exploration-result.js';
import { buildFlowTree, displayName, renderTextTree } from './flow-tree.js';
import { BASE_CSS, card, classPill, esc, renderTreeHtml } from './html-common.js';
import { reportTexts, translateReason, valueLabel, type ReportLanguage } from './i18n.js';
import type { Reporter } from './reporter.js';

/** reports/flow-graph.html — the functional map: tree, states and every transition. */
export class FlowGraphHtmlReporter implements Reporter {
  readonly format = 'flow-graph-html';

  constructor(
    private readonly directory: string,
    private readonly fileName = 'flow-graph.html',
    private readonly language: ReportLanguage = 'en',
  ) {}

  async write(result: ExplorationResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    await writeFile(target, renderFlowGraphHtml(result, this.language), 'utf8');
    return target;
  }
}

export function renderFlowGraphHtml(result: ExplorationResult, language: ReportLanguage = 'en'): string {
  const t = reportTexts(language);
  const c = t.columns;
  const tree = buildFlowTree(result.states, result.transitions, result.states[0]?.id);
  const name = new Map(result.states.map((state) => [state.id, displayName(state)]));
  const nameOf = (id: string): string => name.get(id) ?? id;
  const moves = result.transitions.filter((edge) => edge.result === 'SUCCESS' && edge.from !== edge.to);
  const others = result.transitions.filter((edge) => !(edge.result === 'SUCCESS' && edge.from !== edge.to));

  const edgeRow = (edge: ExplorationResult['transitions'][number]): string =>
    `<tr><td>${esc(nameOf(edge.from))}</td><td class="wrap">${esc(valueLabel(language, edge.action.type))} “${esc(edge.action.text ?? edge.action.label ?? '')}” ${classPill(edge.action.classification, language)}</td><td>${edge.from === edge.to ? `<span class="muted">${esc(t.sameState)}</span>` : `<b>${esc(nameOf(edge.to))}</b>`}</td><td>${classPill(edge.result, language)}${edge.reason ? ` <span class="muted">${esc(translateReason(language, edge.reason))}</span>` : ''}${networkLines(edge)}</td></tr>`;
  const head = `<thead><tr><th>${c.from}</th><th>${c.action}</th><th>${c.to}</th><th>${c.result}</th></tr></thead>`;

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.flowGraphTitle)} — ${esc(result.mission)}</title>
<style>${BASE_CSS} pre.tree-text { background:#0f172a; color:#e2e8f0; padding:14px; border-radius:8px; overflow-x:auto; font-size:12px; }</style>
</head>
<body>
<header>
  <h1>${esc(t.flowGraphTitle)} — ${esc(result.mission)}</h1>
  <div class="meta">${esc(result.target.startUrl)}</div>
  <nav><a href="index.html">${esc(t.backToReport)}</a><a href="flow-graph.json">flow-graph.json</a></nav>
</header>
<main>
  <div class="cards">
    ${card(t.cards.states, result.stats.states)}
    ${card(t.cards.transitions, moves.length)}
    ${card(t.cards.blocked, result.stats.actionsBlocked)}
    ${card(t.cards.failed, result.stats.actionsFailed)}
    ${card(t.cards.maxDepth, result.stats.maxDepth)}
  </div>
  <section><h2>${esc(t.applicationMap)}</h2>${renderTreeHtml(tree, (stateId) => result.issues.filter((issue) => issue.states.includes(stateId)).length, t)}</section>
  <section><h2>${esc(t.textView)}</h2><pre class="tree-text">${esc(renderTextTree(tree))}</pre></section>
  <section><h2>${esc(t.movesTitle)} (${moves.length})</h2>
    <table>${head}<tbody>${moves.map(edgeRow).join('')}</tbody></table>
  </section>
  <section><h2>${esc(t.othersTitle)} (${others.length})</h2>
    <p class="muted">${esc(t.othersHint)}</p>
    <table>${head}<tbody>${others.map(edgeRow).join('')}</tbody></table>
  </section>
</main>
</body>
</html>
`;
}

/** ACTION → NETWORK: the HTTP exchanges of a transition, one per line (POST /api/users 201 184 ms). */
function networkLines(edge: ExplorationResult['transitions'][number]): string {
  if (!edge.network || edge.network.length === 0) return '';
  const lines = edge.network.map((exchange) => {
    let path = exchange.url;
    try {
      const url = new URL(exchange.url);
      path = `${url.pathname}${url.search}`;
    } catch {
      // keep the URL as recorded
    }
    const outcome = exchange.status ?? exchange.failure ?? '…';
    const duration = exchange.durationMs !== undefined ? ` ${exchange.durationMs} ms` : '';
    return `${exchange.method} ${path} ${outcome}${duration}`;
  });
  return `<pre class="network">${esc(lines.join('\n'))}</pre>`;
}
