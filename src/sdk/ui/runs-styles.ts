/**
 * LE STYLE DE LA COMPARAISON D'EXÉCUTIONS, enfermé dans le Shadow DOM. Mêmes variables publiques
 * `--qa-*` que l'assistant et le Studio : l'hôte habille les trois composants d'un seul jeu de valeurs.
 */
export const RUNS_CSS = `
:host{
  --qa-color-primary:#5B5BF6;
  --qa-color-surface:#FFFFFF;--qa-color-surface-2:#F7F8FC;
  --qa-color-text:#141833;--qa-color-muted:#646B85;--qa-color-border:#E6E8F2;--qa-color-border-strong:#D5D9E8;
  --qa-color-success:#0FA88B;--qa-color-warning:#C77700;--qa-color-danger:#E5484D;
  --qa-radius:14px;
  --qa-font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --qa-font-family-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:block;color:var(--qa-color-text);font:14px/1.45 var(--qa-font-family);-webkit-font-smoothing:antialiased;container-type:inline-size;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,select{font:inherit;color:inherit}
code{font-family:var(--qa-font-family-mono);font-size:.86em;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:6px;padding:0 5px}
.mu{color:var(--qa-color-muted)}
:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}
.runs{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);overflow:hidden}
.runs.msg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px 24px;text-align:center}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--qa-color-border);border-top-color:var(--qa-color-primary);animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.tb{display:flex;align-items:flex-end;gap:14px;padding:12px 16px;border-bottom:1px solid var(--qa-color-border);flex-wrap:wrap}
.ttl{margin:0 auto 0 0;font-size:16px;font-weight:800}
.pick{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qa-color-muted);min-width:0}
.pick select{height:34px;padding:0 8px;border:1.5px solid var(--qa-color-border-strong);border-radius:10px;background:var(--qa-color-surface);max-width:100%}
.tabs{display:flex;gap:4px;padding:0 12px;border-bottom:1px solid var(--qa-color-border)}
.tabs button{border:0;background:none;padding:10px 12px;cursor:pointer;color:var(--qa-color-muted);border-bottom:2px solid transparent;font-weight:600}
.tabs button[aria-selected="true"]{color:var(--qa-color-primary);border-bottom-color:var(--qa-color-primary)}
.panel{padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.panel h3{margin:8px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.note{margin:0}
.err{color:var(--qa-color-danger)}
.counts{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px 16px}
.counts b{font-size:16px}
.move{margin:0;padding:8px 10px;border-radius:10px;background:var(--qa-color-surface-2)}
.move.ko{border-left:3px solid var(--qa-color-danger)}
.move.ok{border-left:3px solid var(--qa-color-success)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid currentColor;white-space:nowrap}
.pill.ok{color:var(--qa-color-success)}
.pill.ko{color:var(--qa-color-danger)}
.pill.warn{color:var(--qa-color-warning)}
.pill.mu{color:var(--qa-color-muted)}
.flows,.reqlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.flow{border:1px solid var(--qa-color-border);border-radius:10px;overflow:hidden}
.flow .row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:12px;padding:8px 12px;border:0;background:none;text-align:left;cursor:pointer}
.flow .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flow.open .row{background:var(--qa-color-surface-2)}
.detail{padding:8px 12px 10px}
.changes{margin:0;padding-left:18px}
.reqs{width:100%;border-collapse:collapse}
.reqs th,.reqs td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--qa-color-border);font-weight:400;vertical-align:top}
.reqs thead th{font-size:12px;color:var(--qa-color-muted);font-weight:700}
.reqs tr.chg{background:color-mix(in srgb,var(--qa-color-warning) 8%,transparent)}
.trh{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap}
.trh .counts{flex:1}
.req{border:1px solid var(--qa-color-border);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.req .hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.req p{margin:0}
.crit{font-size:11px;font-weight:700;color:var(--qa-color-muted);letter-spacing:.04em}
.kv{font-size:13px;overflow-wrap:anywhere}
details summary{cursor:pointer;color:var(--qa-color-muted)}
@container (max-width:560px){.flow .row{grid-template-columns:1fr auto}.flow .du{display:none}}
`;
