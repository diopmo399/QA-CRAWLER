/**
 * LE STYLE DU RUN MONITOR, enfermé dans le Shadow DOM. Mêmes variables publiques `--qa-*` que les
 * autres composants du SDK.
 */
export const MONITOR_CSS = `
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
select{font:inherit;color:inherit}
code{font-family:var(--qa-font-family-mono);font-size:.86em;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:6px;padding:0 5px}
.mu{color:var(--qa-color-muted)}
:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}
.mon{background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);overflow:hidden}
.mon.msg{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:32px 24px;text-align:center}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--qa-color-border);border-top-color:var(--qa-color-primary);animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.err{color:var(--qa-color-danger)}
.tb{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--qa-color-border);flex-wrap:wrap}
.ttl{margin:0 auto 0 0;font-size:16px;font-weight:800}
.conn{font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;background:var(--qa-color-surface-2)}
.conn.live{color:var(--qa-color-success)}
.conn.reconnecting,.conn.connecting{color:var(--qa-color-warning)}
.conn.lost{color:var(--qa-color-danger)}
.counts{list-style:none;margin:0;padding:10px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;border-bottom:1px solid var(--qa-color-border)}
.counts b{font-size:16px}
.body{padding:12px 16px;display:flex;flex-direction:column;gap:10px;min-width:0}
.body h3{margin:4px 0 0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted)}
.flows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.flows li{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border:1px solid var(--qa-color-border);border-radius:10px;padding:6px 10px}
.flows .nm{font-weight:700}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid currentColor;white-space:nowrap}
.pill.ok{color:var(--qa-color-success)}
.pill.ko{color:var(--qa-color-danger)}
.pill.warn{color:var(--qa-color-warning)}
.pill.mu{color:var(--qa-color-muted)}
.view{display:flex;flex-wrap:wrap;gap:10px;border:1px solid var(--qa-color-border);border-radius:10px;padding:8px 12px;margin:0}
.view legend{font-size:12px;font-weight:700;color:var(--qa-color-muted);padding:0 4px}
.pick{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--qa-color-muted);min-width:0}
.pick select{height:32px;padding:0 8px;border:1.5px solid var(--qa-color-border-strong);border-radius:10px;background:var(--qa-color-surface);max-width:100%}
.cnt,.note{margin:0;font-size:12px}
.events{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;max-height:420px;overflow:auto;border:1px solid var(--qa-color-border);border-radius:10px}
.ev{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:10px;padding:6px 10px;border-bottom:1px solid var(--qa-color-border);align-items:baseline}
.ev:last-child{border-bottom:0}
.ev time{font-family:var(--qa-font-family-mono);font-size:12px;color:var(--qa-color-muted)}
.ev .ty{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--qa-color-muted);min-width:64px}
.ev .tx{overflow-wrap:anywhere}
.why{font-size:12px}
@container (max-width:520px){.ev{grid-template-columns:1fr}.ev .ty{min-width:0}}
`;
