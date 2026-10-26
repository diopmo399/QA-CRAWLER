/**
 * LE STYLE DE L'ASSISTANT (proposition B validée), enfermé dans le Shadow DOM. L'hôte le règle par
 * des variables CSS publiques posées sur l'élément ; aucune règle ne sort de l'élément.
 *
 *   --qa-color-primary, --qa-color-primary-2   accent et dégradé
 *   --qa-color-background, --qa-color-surface  fond de page, cartes
 *   --qa-color-text, --qa-color-muted, --qa-color-border
 *   --qa-color-panel, --qa-color-panel-2       panneau du parcours (mode autonome)
 *   --qa-color-success, --qa-color-warning, --qa-color-danger
 *   --qa-radius, --qa-font-family, --qa-font-family-heading, --qa-font-family-mono
 */
export const WIZARD_CSS = `
:host{
  --qa-color-primary:#5B5BF6;--qa-color-primary-2:#7C4DFF;
  --qa-color-background:#F5F6FB;--qa-color-surface:#FFFFFF;--qa-color-surface-2:#F7F8FC;
  --qa-color-text:#141833;--qa-color-muted:#646B85;--qa-color-faint:#9AA0B8;--qa-color-border:#E6E8F2;--qa-color-border-strong:#D5D9E8;
  --qa-color-panel:#171A45;--qa-color-panel-2:#2A2370;
  --qa-color-success:#0FA88B;--qa-color-success-soft:#E3F7F2;--qa-color-warning:#C77700;--qa-color-warning-soft:#FFF4DF;
  --qa-color-danger:#E5484D;--qa-color-danger-soft:#FDECEC;
  --qa-radius:14px;
  --qa-font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --qa-font-family-heading:"Plus Jakarta Sans",var(--qa-font-family);
  --qa-font-family-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:block;container-type:inline-size;color:var(--qa-color-text);font:14px/1.5 var(--qa-font-family);-webkit-font-smoothing:antialiased;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,input,select,textarea{font:inherit;color:inherit}
.mono{font-family:var(--qa-font-family-mono);font-size:.92em}
.hd{font-family:var(--qa-font-family-heading)}
.ico{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}

.win{min-height:100%;display:flex;flex-direction:column;background:radial-gradient(900px 520px at 12% 0%,color-mix(in srgb,var(--qa-color-primary) 14%,transparent),transparent 70%),radial-gradient(800px 600px at 100% 100%,#E3F3FF,transparent 65%),var(--qa-color-background)}
.bar{height:64px;flex:none;display:flex;align-items:center;gap:12px;padding:0 40px}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--qa-color-primary),var(--qa-color-primary-2));display:grid;place-items:center;box-shadow:0 6px 16px color-mix(in srgb,var(--qa-color-primary) 35%,transparent);overflow:hidden}
.logo i{width:11px;height:11px;border:2.6px solid #fff;border-radius:50%}
.logo img{width:100%;height:100%;object-fit:cover}
.bar .nm{font-weight:800;font-size:15px;letter-spacing:.01em}
.bar .tag{font-size:12.5px;color:var(--qa-color-muted);padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--qa-color-surface) 70%,transparent);border:1px solid var(--qa-color-border)}
.sp{flex:1}
.stage{flex:1;padding:4px 40px 40px;display:flex;min-height:0}
.card{flex:1;display:flex;background:var(--qa-color-surface);border-radius:calc(var(--qa-radius) + 8px);box-shadow:0 30px 70px -20px rgba(23,26,69,.28),0 2px 6px rgba(23,26,69,.06);overflow:hidden;min-height:640px}

.pan{width:320px;flex:none;background:radial-gradient(420px 300px at 0% 0%,color-mix(in srgb,var(--qa-color-primary-2) 45%,transparent),transparent 70%),linear-gradient(170deg,var(--qa-color-panel),var(--qa-color-panel-2));color:#E9EAFB;padding:34px 28px 26px;display:flex;flex-direction:column;gap:24px}
.pan h2{margin:0;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#A9ACE0;font-weight:700}
.steps{display:flex;flex-direction:column;list-style:none;margin:0;padding:0}
.step{position:relative}
.step:not(:last-child):before{content:"";position:absolute;left:15px;top:41px;bottom:-9px;width:2px;background:rgba(255,255,255,.12);border-radius:2px}
.step.done:not(:last-child):before{background:linear-gradient(#3DDBB8,rgba(61,219,184,.35))}
.step button{all:unset;box-sizing:border-box;display:flex;gap:14px;align-items:flex-start;padding:9px 0;width:100%;cursor:default}
.step button:not(:disabled){cursor:pointer}
.step button:focus-visible{outline:2px solid #fff;outline-offset:2px;border-radius:8px}
.step .c{width:32px;height:32px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:13px;font-weight:700;border:1.5px solid rgba(255,255,255,.22);color:#B9BCEB}
.step.done .c{background:#3DDBB8;border-color:#3DDBB8;color:#0B3B32}
.step.on .c{background:#fff;border-color:#fff;color:var(--qa-color-primary);box-shadow:0 0 0 5px rgba(255,255,255,.14),0 0 24px rgba(160,150,255,.65)}
.step.err .c{background:var(--qa-color-danger);border-color:var(--qa-color-danger);color:#fff;box-shadow:0 0 0 5px rgba(229,72,77,.2)}
.step b{display:block;font-size:14.5px;font-weight:600;color:#fff}
.step small{font-size:12.5px;color:#A9ACE0}
.step.todo b{color:#C9CBEF}
.fiche{margin-top:auto;border-radius:16px;padding:16px 16px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}
.fiche .t{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:#A9ACE0;font-weight:700;display:flex;align-items:center;gap:8px;margin-bottom:8px}
.fiche .t i{width:6px;height:6px;border-radius:50%;background:#3DDBB8;box-shadow:0 0 8px #3DDBB8}
.fiche dl{margin:0;display:grid;grid-template-columns:88px 1fr;gap:6px 10px;font-size:12.5px}
.fiche dt{color:#9095C9}.fiche dd{margin:0;color:#F1F1FF;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fiche dd.e{color:#6E73A8}

.ct{flex:1;min-width:0;display:flex;flex-direction:column}
.prog{height:4px;background:var(--qa-color-border);flex:none}.prog i{display:block;height:100%;background:linear-gradient(90deg,var(--qa-color-primary),var(--qa-color-primary-2));border-radius:0 4px 4px 0;transition:width .3s}
.in2{flex:1;padding:34px 52px 28px;display:flex;flex-direction:column;gap:22px;min-width:0}
.eb{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--qa-color-primary);font-weight:700}
h1{font:800 29px/1.15 var(--qa-font-family-heading);letter-spacing:-.012em;margin:4px 0 0}
.lead{color:var(--qa-color-muted);font-size:15px;margin:8px 0 0;max-width:640px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 22px}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 22px}
.f{display:flex;flex-direction:column;gap:7px;min-width:0}
.f>label,.f>.l{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px}
.f>label em,.f>.l em{font-style:normal;color:var(--qa-color-faint);font-weight:500;font-size:12.5px}
.ip{display:flex;align-items:center;gap:10px;height:48px;border:1.5px solid var(--qa-color-border-strong);border-radius:12px;padding:0 14px;background:var(--qa-color-surface);min-width:0}
.ip:focus-within{border-color:var(--qa-color-primary);box-shadow:0 0 0 4px color-mix(in srgb,var(--qa-color-primary) 14%,transparent)}
.ip.bad{border-color:var(--qa-color-danger);box-shadow:0 0 0 4px color-mix(in srgb,var(--qa-color-danger) 12%,transparent)}
.ip .ico{color:var(--qa-color-faint)}
.ip input,.ip select{border:0;outline:0;background:transparent;flex:1;min-width:0;height:100%;font-size:14.5px}
.ip select{appearance:auto;cursor:pointer}
.ip.ta{height:auto;padding:10px 14px;align-items:flex-start}.ip.ta textarea{border:0;outline:0;resize:vertical;min-height:56px;width:100%;background:transparent}
.ip .static{flex:1}
.hint{font-size:12.5px;color:var(--qa-color-muted)}
.err-t{font-size:12.5px;color:var(--qa-color-danger);font-weight:600}
.chk{display:flex;gap:8px;flex-wrap:wrap}
.ck{white-space:nowrap;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:999px}
.ck.ok{background:var(--qa-color-success-soft);color:#0B7A65}.ck.w{background:var(--qa-color-warning-soft);color:var(--qa-color-warning)}.ck.e{background:var(--qa-color-danger-soft);color:#B4232A}.ck.n{background:var(--qa-color-surface-2);color:var(--qa-color-muted);border:1px solid var(--qa-color-border)}
.ck .ico{width:14px;height:14px;stroke-width:2.2}
.wrapmsg{white-space:normal}
.tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.tile{all:unset;box-sizing:border-box;border:1.5px solid var(--qa-color-border);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:10px;background:var(--qa-color-surface);position:relative;cursor:pointer}
.tile .gl{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.tile b{font-size:15px}.tile span.d{font-size:12.5px;color:var(--qa-color-muted);line-height:1.4}
.tile[aria-checked="true"]{border-color:var(--qa-color-primary);background:linear-gradient(180deg,color-mix(in srgb,var(--qa-color-primary) 6%,var(--qa-color-surface)),var(--qa-color-surface));box-shadow:0 10px 24px -12px color-mix(in srgb,var(--qa-color-primary) 45%,transparent)}
.tile[aria-checked="true"] .gl{background:linear-gradient(135deg,var(--qa-color-primary),var(--qa-color-primary-2));color:#fff}
.tile .tick{position:absolute;top:12px;right:12px;width:20px;height:20px;border-radius:50%;background:var(--qa-color-primary);color:#fff;display:none;place-items:center}
.tile[aria-checked="true"] .tick{display:grid}
.tile .tick .ico{width:12px;height:12px;stroke-width:3}
.seg{display:inline-flex;background:var(--qa-color-surface-2);border:1px solid var(--qa-color-border);border-radius:12px;padding:4px;gap:4px;flex-wrap:wrap}
.seg button{all:unset;padding:8px 16px;border-radius:9px;font-size:13.5px;font-weight:600;color:var(--qa-color-muted);display:inline-flex;gap:7px;align-items:center;cursor:pointer}
.seg button[aria-checked="true"]{background:var(--qa-color-surface);color:var(--qa-color-text);box-shadow:0 1px 3px rgba(20,24,51,.12)}
.seg button:focus-visible{outline:2px solid var(--qa-color-primary)}
.box{border:1px solid var(--qa-color-border);border-radius:16px;padding:18px 20px;background:var(--qa-color-surface-2);display:flex;flex-direction:column;gap:14px;min-width:0}
.box.white{background:var(--qa-color-surface)}
.box h3{margin:0;font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px}
.lock{display:flex;gap:12px;align-items:flex-start;border-radius:14px;padding:14px 16px;background:linear-gradient(135deg,color-mix(in srgb,var(--qa-color-primary) 7%,var(--qa-color-surface)),#EEF6FF);border:1px solid color-mix(in srgb,var(--qa-color-primary) 18%,var(--qa-color-border));font-size:13px}
.lock .ico{color:var(--qa-color-primary);margin-top:1px}
.var{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;background:var(--qa-color-surface);border:1px solid var(--qa-color-border);font-size:13px}
.var .dt{width:8px;height:8px;border-radius:50%;background:var(--qa-color-faint)}.var .dt.ok{background:var(--qa-color-success)}.var .dt.e{background:var(--qa-color-danger)}
.rng{display:flex;flex-direction:column;gap:6px}
.rng .lab{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px}.rng .lab b{font-size:15px}
.rng input[type=range]{width:100%;accent-color:var(--qa-color-primary);height:22px;margin:0}
.rng input[type=number]{width:84px;border:1px solid var(--qa-color-border-strong);border-radius:8px;padding:3px 6px;text-align:right;font-weight:700}
.sw{position:relative;width:42px;height:24px;flex:none}
.sw input{appearance:none;margin:0;width:42px;height:24px;border-radius:999px;background:var(--qa-color-border-strong);cursor:pointer;transition:background .15s}
.sw input:checked{background:linear-gradient(90deg,var(--qa-color-primary),var(--qa-color-primary-2))}
.sw input:disabled{cursor:not-allowed;opacity:.7}
.sw:after{content:"";position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;top:3px;left:3px;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .15s;pointer-events:none}
.sw:has(input:checked):after{left:21px}
.tg{display:flex;gap:14px;align-items:center;padding:9px 0;border-top:1px solid var(--qa-color-border)}
.tg:first-of-type{border-top:0;padding-top:0}
.tg b{display:block;font-size:14px}.tg span{font-size:12.5px;color:var(--qa-color-muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--qa-color-border);background:var(--qa-color-surface);border-radius:8px;padding:3px 4px 3px 10px;font-size:12.5px}
.chip.fixed{padding-right:10px;color:var(--qa-color-muted)}
.chip button{all:unset;cursor:pointer;width:20px;height:20px;border-radius:6px;display:grid;place-items:center;color:var(--qa-color-muted)}
.chip button:hover{background:var(--qa-color-surface-2);color:var(--qa-color-danger)}
.adder{display:inline-flex;gap:6px}
.adder input{border:1px dashed var(--qa-color-border-strong);border-radius:8px;padding:4px 8px;font-size:12.5px;width:200px;background:var(--qa-color-surface)}
.btn{all:unset;box-sizing:border-box;height:46px;border-radius:12px;padding:0 20px;display:inline-flex;align-items:center;justify-content:center;gap:9px;font-weight:600;font-size:14.5px;border:1.5px solid var(--qa-color-border-strong);background:var(--qa-color-surface);color:var(--qa-color-text);cursor:pointer;white-space:nowrap}
.btn.sm{height:34px;padding:0 12px;font-size:13px;border-radius:9px}
.btn.p{border-color:transparent;background:linear-gradient(135deg,var(--qa-color-primary),var(--qa-color-primary-2));color:#fff;box-shadow:0 10px 22px -8px color-mix(in srgb,var(--qa-color-primary) 60%,transparent)}
.btn.g{border-color:transparent;background:transparent;color:var(--qa-color-muted)}
.btn:disabled,.btn[aria-disabled="true"]{opacity:.42;box-shadow:none;cursor:not-allowed}
.btn:focus-visible{outline:3px solid color-mix(in srgb,var(--qa-color-primary) 45%,transparent);outline-offset:2px}
.ft{flex:none;display:flex;align-items:center;gap:12px;padding:18px 52px 24px;border-top:1px solid var(--qa-color-border);background:var(--qa-color-surface);flex-wrap:wrap}
.ft .kbd{font-size:12px;color:var(--qa-color-faint)}
.alert{display:flex;gap:12px;align-items:flex-start;border-radius:14px;padding:14px 16px;font-size:13.5px}
.alert ul{margin:4px 0 0;padding-left:18px}
.alert.e{background:var(--qa-color-danger-soft);color:#7F1D23;border:1px solid #F6C6C8}.alert.e .ico{color:var(--qa-color-danger)}
.alert.w{background:var(--qa-color-warning-soft);color:#6B4200;border:1px solid #F6DDAA}.alert.w .ico{color:var(--qa-color-warning)}
.alert.ok{background:var(--qa-color-success-soft);color:#0B5B4C;border:1px solid #BCEBDD}.alert.ok .ico{color:var(--qa-color-success)}
.alert .link{all:unset;cursor:pointer;font-weight:700;text-decoration:underline}
.rc{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.rcard{border:1px solid var(--qa-color-border);border-radius:16px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;min-width:0}
.rcard .h{display:flex;align-items:center;gap:10px}
.rcard .h .gl{width:32px;height:32px;border-radius:10px;background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));color:var(--qa-color-primary);display:grid;place-items:center}
.rcard .h b{font-size:14px}.rcard .h button{all:unset;margin-left:auto;font-size:12.5px;font-weight:600;color:var(--qa-color-primary);cursor:pointer}
.rcard dl{margin:0;display:grid;grid-template-columns:96px 1fr;gap:5px 10px;font-size:13px}
.rcard dt{color:var(--qa-color-muted)}.rcard dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.yaml{margin:0;background:#0E1330;color:#D6DEEB;border-radius:16px;padding:14px 18px;font:12px/1.6 var(--qa-font-family-mono);max-height:260px;overflow:auto;white-space:pre}
.yaml .k{color:#C4B5FD}.yaml .c{color:#7C8DB5}
.st-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.live{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:999px;background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));color:var(--qa-color-primary);font-weight:700;font-size:13px}
.live i{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px color-mix(in srgb,currentColor 20%,transparent)}
.live.ok{background:var(--qa-color-success-soft);color:var(--qa-color-success)}.live.e{background:var(--qa-color-danger-soft);color:var(--qa-color-danger)}.live.q{background:var(--qa-color-surface-2);color:var(--qa-color-muted)}
.meta{color:var(--qa-color-muted);font-size:13px}
.rings{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.ring{border:1px solid var(--qa-color-border);border-radius:18px;padding:16px 18px;display:flex;gap:16px;align-items:center;background:var(--qa-color-surface);min-width:0}
.ring svg{flex:none}
.ring small{display:block;color:var(--qa-color-muted);font-size:12.5px}
.ring b{font:800 26px/1.2 var(--qa-font-family-heading);letter-spacing:-.02em;white-space:nowrap}
.ring em{font-style:normal;color:var(--qa-color-faint);font-size:13px;margin-left:4px;white-space:nowrap}
.ring .gl{width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--qa-color-warning-soft);color:var(--qa-color-warning);flex:none}
.ring.col{flex-direction:column;align-items:flex-start;gap:2px}
.two{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:16px;min-height:0}
.panel{border:1px solid var(--qa-color-border);border-radius:18px;background:var(--qa-color-surface);padding:16px 18px;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:260px}
.panel h3{margin:0;font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--qa-color-muted);font-weight:700;display:flex;align-items:center;gap:8px}
.panel h3 .ck{text-transform:none;letter-spacing:0;margin-left:auto}
.map{overflow:auto;max-height:340px}
.map svg{display:block}
.empty{color:var(--qa-color-faint);font-size:13px;padding:8px 0}
.feed{display:flex;flex-direction:column;max-height:340px;overflow:auto}
.ev{display:grid;grid-template-columns:48px 28px minmax(0,1fr);gap:6px;align-items:center;padding:7px 0;border-top:1px solid var(--qa-color-border);font-size:13px}
.ev:first-child{border-top:0}
.ev time{color:var(--qa-color-faint);font:12px var(--qa-font-family-mono)}
.ev .bdg{width:24px;height:24px;border-radius:8px;display:grid;place-items:center}
.ev .bdg .ico{width:14px;height:14px;stroke-width:2.2}
.ev span.m{min-width:0;overflow:hidden;text-overflow:ellipsis}
.b-state{background:var(--qa-color-success-soft);color:#0B7A65}.b-transition{background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));color:var(--qa-color-primary)}.b-issue{background:var(--qa-color-warning-soft);color:var(--qa-color-warning)}.b-blocked{background:var(--qa-color-surface-2);color:var(--qa-color-muted)}.b-authenticated{background:#EAF4FF;color:#1D6FD1}.b-phase,.b-status{background:var(--qa-color-surface-2);color:var(--qa-color-muted)}.b-failed{background:var(--qa-color-danger-soft);color:var(--qa-color-danger)}.b-completed{background:var(--qa-color-success-soft);color:var(--qa-color-success)}
.anom{display:grid;grid-template-columns:86px minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--qa-color-border);font-size:13px}
.anom:first-child{border-top:0}
.anom .where{color:var(--qa-color-muted);font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rep{display:flex;gap:14px;align-items:center;padding:10px 0;border-top:1px solid var(--qa-color-border)}
.rep:first-of-type{border-top:0}
.rep .gl{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--qa-color-surface-2);color:var(--qa-color-muted);flex:none}
.rep b{display:block;font-size:14px}.rep span{font-size:12.5px;color:var(--qa-color-muted)}
.medal{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;color:#fff;flex:none;background:linear-gradient(135deg,#19C39E,var(--qa-color-success));box-shadow:0 14px 28px -10px color-mix(in srgb,var(--qa-color-success) 60%,transparent)}
.medal.e{background:linear-gradient(135deg,#F47073,var(--qa-color-danger))}
.medal .ico{width:32px;height:32px;stroke-width:2.6}
.foot-note{font-size:12.5px;color:var(--qa-color-muted);display:flex;gap:8px;align-items:center}
.center{flex:1;display:grid;place-items:center;padding:40px;text-align:center;color:var(--qa-color-muted)}
.spin{width:22px;height:22px;border-radius:50%;border:3px solid color-mix(in srgb,var(--qa-color-primary) 25%,transparent);border-top-color:var(--qa-color-primary);animation:spin 1s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}.prog i{transition:none}}

/* MODE EMBARQUÉ : ni barre ni panneau sombre ; une barre d'étapes compacte ; l'hôte garde sa mise en page. */
:host([mode="embedded"]) .win{background:transparent;min-height:0}
:host([mode="embedded"]) .bar{display:none}
:host([mode="embedded"]) .stage{padding:0}
:host([mode="embedded"]) .card{box-shadow:0 10px 30px -12px rgba(15,23,42,.22);border-radius:calc(var(--qa-radius) + 4px);min-height:0}
:host([mode="embedded"]) .pan{display:none}
.hsteps{display:none;list-style:none;margin:0;padding:14px 22px;gap:6px;align-items:center;border-bottom:1px solid var(--qa-color-border);flex-wrap:wrap}
:host([mode="embedded"]) .hsteps{display:flex}
:host([mode="embedded"]) .prog{display:none}
.hsteps li{display:flex;align-items:center;gap:6px}
.hsteps button{all:unset;display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:600;color:var(--qa-color-muted)}
.hsteps button:not(:disabled){cursor:pointer}
.hsteps .c{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;border:1.5px solid var(--qa-color-border-strong)}
.hsteps .on button{background:color-mix(in srgb,var(--qa-color-primary) 10%,var(--qa-color-surface));color:var(--qa-color-text)}
.hsteps .on .c{background:var(--qa-color-primary);border-color:var(--qa-color-primary);color:#fff}
.hsteps .done .c{background:var(--qa-color-success-soft);border-color:var(--qa-color-success-soft);color:var(--qa-color-success)}
.hsteps .err .c{background:var(--qa-color-danger);border-color:var(--qa-color-danger);color:#fff}
.hsteps .sep{color:var(--qa-color-border-strong)}
:host([mode="embedded"]) .in2{padding:24px 26px 20px}
:host([mode="embedded"]) .ft{padding:16px 26px 20px}

/* LARGEUR DU CONTENEUR (container queries) : la mise en page suit l'emplacement, pas l'écran. */
@container (max-width:1100px){
  .tiles,.rings{grid-template-columns:repeat(2,minmax(0,1fr))}
  .rc{grid-template-columns:minmax(0,1fr)}
  .two{grid-template-columns:minmax(0,1fr)}
}
@container (max-width:860px){
  .pan{display:none}
  .hsteps{display:flex}
  .bar,.stage{padding-left:16px;padding-right:16px}
  .in2{padding:22px 20px}
  .ft{padding:14px 20px 18px}
  .grid2,.grid3{grid-template-columns:minmax(0,1fr)}
  .card{min-height:0}
}
@container (max-width:520px){
  .tiles,.rings{grid-template-columns:minmax(0,1fr)}
  h1{font-size:24px}
}
`;
