/**
 * LE STYLE DU FLOW STUDIO, enfermé dans le Shadow DOM. Mêmes variables publiques `--qa-*` que
 * l'assistant : l'hôte habille les deux composants d'un seul jeu de valeurs.
 */
export const STUDIO_CSS = `
:host{
  --qa-color-primary:#5B5BF6;--qa-color-primary-2:#7C4DFF;
  --qa-color-background:#F5F6FB;--qa-color-surface:#FFFFFF;--qa-color-surface-2:#F7F8FC;
  --qa-color-text:#141833;--qa-color-muted:#646B85;--qa-color-faint:#9AA0B8;--qa-color-border:#E6E8F2;--qa-color-border-strong:#D5D9E8;
  --qa-color-success:#0FA88B;--qa-color-warning:#C77700;--qa-color-danger:#E5484D;
  --qa-color-data:#2F7DE1;
  --qa-radius:14px;
  --qa-font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --qa-font-family-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:block;height:640px;min-height:360px;color:var(--qa-color-text);font:14px/1.45 var(--qa-font-family);-webkit-font-smoothing:antialiased;container-type:inline-size;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,input,select,textarea{font:inherit;color:inherit}
code{font-family:var(--qa-font-family-mono);font-size:.86em;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:6px;padding:0 5px}
.ico{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.mu{color:var(--qa-color-muted)}
:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}

.studio{height:100%;display:flex;flex-direction:column;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);border-radius:var(--qa-radius);overflow:hidden}
.studio.msg{align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--qa-color-border);border-top-color:var(--qa-color-primary);animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}

.tb{flex:none;display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--qa-color-border);flex-wrap:wrap}
.tb .ttl{font-weight:800}
.tb .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px}
.sp{flex:1}
.search{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1.5px solid var(--qa-color-border-strong);border-radius:10px;min-width:220px;color:var(--qa-color-muted)}
.search input{border:0;outline:0;background:transparent;min-width:0;flex:1;color:var(--qa-color-text)}
.search output{font-size:12px;white-space:nowrap}
.zoom{display:flex;align-items:center;gap:6px}
.zv{font-size:12px;min-width:44px;text-align:center;color:var(--qa-color-muted)}
.ib{width:32px;height:32px;border-radius:9px;border:1.5px solid var(--qa-color-border-strong);background:var(--qa-color-surface);cursor:pointer;font-weight:700}
.btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:9px;border:1.5px solid var(--qa-color-border-strong);background:var(--qa-color-surface);cursor:pointer;font-weight:600;font-size:13px;white-space:nowrap}
.btn:hover,.ib:hover{border-color:var(--qa-color-primary)}
.btn.pri{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:#fff}
.btn.danger{color:var(--qa-color-danger)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.lnk{all:unset;cursor:pointer;color:var(--qa-color-primary);font-weight:600}

.body{flex:1;display:flex;min-height:0}
.canvas{flex:1;min-width:0;position:relative;background:
  radial-gradient(circle at 1px 1px,var(--qa-color-border) 1px,transparent 1.2px) 0 0/22px 22px,var(--qa-color-surface-2);cursor:grab;touch-action:none;overflow:hidden}
.canvas.panning{cursor:grabbing}
.g{width:100%;height:100%;display:block;user-select:none}
.side{width:320px;flex:none;border-left:1px solid var(--qa-color-border);padding:16px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.side h2{margin:0;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--qa-color-muted)}
.side h3{margin:6px 0 0;font-size:12.5px}
.side p{margin:0}
.side .nm{font-weight:700;font-size:15px;overflow-wrap:anywhere}
.side dl{display:grid;grid-template-columns:96px 1fr;gap:6px 10px;margin:0;font-size:13px}
.side dt{color:var(--qa-color-muted)}.side dd{margin:0;min-width:0;overflow-wrap:anywhere}
.side .ok{color:var(--qa-color-success)}.side .warn,.warn{color:var(--qa-color-warning)}
.stats{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stats li{border:1px solid var(--qa-color-border);border-radius:10px;padding:8px 10px;font-size:12.5px;color:var(--qa-color-muted)}
.stats b{display:block;font-size:18px;color:var(--qa-color-text)}
.stats li.bad b{color:var(--qa-color-danger)}
.legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px}
.legend li{display:flex;align-items:center;gap:8px}
.legend i{display:inline-block;width:22px;height:0;border-top:2px solid var(--qa-color-faint)}
.legend .l-data{border-top:2px dashed var(--qa-color-data)}
.legend .l-bad{border-top:2px dashed var(--qa-color-danger)}
.legend .d{width:9px;height:9px;border:0;border-radius:50%}
.d.r-ok,.pill.r-ok{background:var(--qa-color-success)}.d.r-ko,.pill.r-ko{background:var(--qa-color-danger)}.d.r-warn,.pill.r-warn{background:var(--qa-color-warning)}
.d.r-none{background:transparent;box-shadow:inset 0 0 0 1.5px var(--qa-color-faint)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;color:#fff;font-size:12px;font-weight:600}
.pill.r-none{background:var(--qa-color-surface-2);color:var(--qa-color-muted);border:1px solid var(--qa-color-border)}
.reasons,.io,.picked{margin:4px 0 0;padding-left:18px;font-size:12.5px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.col{display:flex;flex-direction:column;gap:6px}
.row label{font-size:12.5px;color:var(--qa-color-muted)}
.side input,.side select,.side textarea{border:1.5px solid var(--qa-color-border-strong);border-radius:9px;padding:6px 9px;background:var(--qa-color-surface);min-width:0;flex:1}
.notice{border-radius:10px;padding:10px 12px;font-size:13px;border:1px solid}
.notice p{margin:4px 0 0}.notice ul{margin:6px 0 0;padding-left:18px}
.n-ok{border-color:color-mix(in srgb,var(--qa-color-success) 40%,transparent);background:color-mix(in srgb,var(--qa-color-success) 9%,transparent)}
.n-refused,.n-error{border-color:color-mix(in srgb,var(--qa-color-danger) 40%,transparent);background:color-mix(in srgb,var(--qa-color-danger) 8%,transparent)}

.frame>rect{fill:color-mix(in srgb,var(--qa-color-primary) 5%,var(--qa-color-surface));stroke:color-mix(in srgb,var(--qa-color-primary) 30%,var(--qa-color-border));stroke-width:1.2}
.frame.on>rect{stroke:var(--qa-color-primary);stroke-width:2}
.frame .hit{fill:transparent;stroke:none;cursor:move}
.frame .fn{font-weight:700;font-size:13px;fill:var(--qa-color-text)}
.frame .fc{font-size:12px;fill:var(--qa-color-muted)}
.frame .tg{cursor:pointer}.frame .tg .hit{fill:var(--qa-color-surface);stroke:var(--qa-color-border-strong);cursor:pointer}
.chev{fill:none;stroke:var(--qa-color-muted);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.e{fill:none;stroke-width:1.6}
.e-sequence{stroke:var(--qa-color-faint)}
.e-data{stroke:var(--qa-color-data);stroke-dasharray:5 4;opacity:.35}
.e-violation{stroke:var(--qa-color-danger);stroke-dasharray:5 4;stroke-width:2}
.e.on{opacity:1;stroke-width:2.2}
.ek{font-size:11px;fill:var(--qa-color-data);text-anchor:middle;paint-order:stroke;stroke:var(--qa-color-surface-2);stroke-width:4px}
.e-violation+.ek{fill:var(--qa-color-danger)}
.mk-seq{fill:var(--qa-color-faint)}.mk-data{fill:var(--qa-color-data)}.mk-bad{fill:var(--qa-color-danger)}
.node{cursor:pointer}
.node .card{fill:var(--qa-color-surface);stroke:var(--qa-color-border-strong);stroke-width:1.2}
.node .kind{fill:var(--qa-color-faint)}
.node.k-nav .kind{fill:var(--qa-color-primary)}.node.k-fill .kind{fill:var(--qa-color-data)}.node.k-exp .kind{fill:var(--qa-color-success)}.node.k-act .kind{fill:var(--qa-color-primary-2)}
.node .pos{font-size:11px;fill:var(--qa-color-muted);font-family:var(--qa-font-family-mono)}
.node .lb{font-size:12.5px;fill:var(--qa-color-text)}
.node .dt{font-size:11px;text-anchor:end}
.dp{fill:var(--qa-color-data)}.dc{fill:var(--qa-color-muted)}
.node .rp{fill:transparent;stroke:var(--qa-color-faint);stroke-width:1.5}
.node.r-ok .rp{fill:var(--qa-color-success);stroke:none}.node.r-ko .rp{fill:var(--qa-color-danger);stroke:none}.node.r-warn .rp{fill:var(--qa-color-warning);stroke:none}
.node.r-ok .card{stroke:color-mix(in srgb,var(--qa-color-success) 55%,var(--qa-color-border-strong))}
.node.r-ko .card{stroke:var(--qa-color-danger);stroke-width:1.6}
.node.bad .card{stroke:var(--qa-color-danger);stroke-dasharray:4 3}
.node.sel .card{stroke:var(--qa-color-primary);stroke-width:2.4}
.node.cur .card{stroke:var(--qa-color-warning);stroke-width:2.4}
.node.dim{opacity:.28}
.node.dragging{opacity:.85}
.node.summary .card{fill:var(--qa-color-surface-2);stroke-dasharray:4 3}
.node:focus-visible .card{stroke:var(--qa-color-primary);stroke-width:3}
.node:focus{outline:none}

@container (max-width:760px){.side{width:100%;border-left:0;border-top:1px solid var(--qa-color-border);max-height:45%}.body{flex-direction:column}.search{min-width:0;flex:1}}
`;
