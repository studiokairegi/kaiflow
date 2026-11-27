// One stylesheet for the Finance V3 screens. Colours follow the KairFlow dark theme; everything is scoped under .fv3 so nothing leaks into the app.
export const FINANCE_CSS = `
.fv3{--bg:#14191c;--surface:#1c2327;--raised:#232c31;--border:#2a3338;--rule:rgba(255,255,255,.07);--text:#EDEAE3;--muted:#9aa8a6;--faint:#6f7e7c;--accent:#38B6FF;--accent-text:#7CCBFF;
  --ok:#34D8A0;--warn:#F2A65A;--bad:#FF6B6B;--info:#77A1FF;--focus:#7CCBFF;color:var(--text);font-family:'Inter',system-ui,sans-serif;font-size:14px;line-height:1.5;
  max-width:1384px;margin:0 auto;padding:0 0 64px;box-sizing:border-box;width:100%}
.fv3 *,.fv3 *::before,.fv3 *::after{box-sizing:border-box}
.fv3 h1,.fv3 h2,.fv3 h3{font-family:'Space Grotesk',system-ui,sans-serif;margin:0;letter-spacing:-.01em;color:var(--text)}
.fv3 h1{font-size:22px;font-weight:800}.fv3 h2{font-size:18px;font-weight:800}.fv3 h3{font-size:15px;font-weight:700}
.fv3 p{margin:0}.fv3 .sub{color:var(--muted);font-size:12.5px}
.fv3 :focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:6px}
.fv3 .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fv3 .head{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:4px 0 16px}
.fv3 .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.fv3 .stack{display:flex;flex-direction:column;gap:14px}
.fv3 .grow{flex:1 1 auto;min-width:0}
.fv3 .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(210px,1fr))}
.fv3 .grid2{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.fv3 .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;min-width:0}
.fv3 .stat{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-width:0}
.fv3 .stat.hero{border-left-color:var(--ok);background:linear-gradient(135deg,#1c2a27,#1c2327)}
.fv3 .stat.bad{border-left-color:var(--bad)}.fv3 .stat.warn{border-left-color:var(--warn)}
.fv3 .stat .v{font-family:'Space Grotesk',system-ui,sans-serif;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.fv3 .stat.hero .v{font-size:28px}
.fv3 .stat .l{font-size:12.5px;color:var(--muted)}
.fv3 .btn{appearance:none;border:1px solid var(--border);background:var(--raised);color:var(--text);border-radius:8px;padding:8px 14px;min-height:38px;font:inherit;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px;justify-content:center}
.fv3 .btn:hover:not(:disabled){border-color:var(--accent)}
.fv3 .btn.primary{background:var(--accent);border-color:var(--accent);color:#06222f}
.fv3 .btn.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
.fv3 .btn.ghost{background:transparent}
.fv3 .btn.small{min-height:30px;padding:4px 10px;font-size:12.5px}
.fv3 .btn:disabled{opacity:.55;cursor:not-allowed}
.fv3 .pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;border:1px solid var(--border);color:var(--muted);white-space:nowrap}
.fv3 .pill.ok{color:var(--ok);border-color:rgba(52,216,160,.4)}.fv3 .pill.warn{color:var(--warn);border-color:rgba(242,166,90,.4)}
.fv3 .pill.bad{color:var(--bad);border-color:rgba(255,107,107,.4)}.fv3 .pill.info{color:var(--info);border-color:rgba(119,161,255,.4)}
.fv3 .banner{border:1px solid var(--border);border-left-width:4px;border-radius:10px;padding:10px 14px;background:var(--surface);display:flex;flex-direction:column;gap:2px}
.fv3 .banner.critical,.fv3 .banner.bad{border-left-color:var(--bad)}.fv3 .banner.warning,.fv3 .banner.warn{border-left-color:var(--warn)}
.fv3 .banner.info{border-left-color:var(--info)}.fv3 .banner.ok{border-left-color:var(--ok)}
.fv3 .banner b{font-weight:700}
.fv3 .field{display:flex;flex-direction:column;gap:5px;min-width:0}.fv3 .field>label{font-size:12.5px;color:var(--muted)}
.fv3 .field .hint{font-size:12px;color:var(--faint)}.fv3 .field .err{font-size:12.5px;color:var(--bad)}
.fv3 input,.fv3 select,.fv3 textarea{background:rgba(0,0,0,.25);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 12px;min-height:38px;font:inherit;width:100%;max-width:100%}
.fv3 textarea{min-height:96px;resize:vertical}
.fv3 input[aria-invalid=true],.fv3 select[aria-invalid=true],.fv3 textarea[aria-invalid=true]{border-color:var(--bad)}
.fv3 input[type=checkbox]{width:18px;min-height:18px;height:18px}
.fv3 .tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:thin}
.fv3 .tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.fv3 .tab[aria-selected=true]{color:var(--text);border-bottom-color:var(--accent)}
.fv3 .navgroup{display:flex;flex-wrap:wrap;gap:6px}
.fv3 .chip{appearance:none;border:1px solid var(--border);background:var(--surface);color:var(--muted);border-radius:999px;padding:6px 12px;font:inherit;cursor:pointer}
.fv3 .chip[aria-current=page]{color:var(--text);border-color:var(--accent);background:var(--raised)}
.fv3 table.fv3-table{width:100%;border-collapse:collapse}
.fv3 .fv3-table th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.fv3 .fv3-table td{padding:9px 10px;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
.fv3 .fv3-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.fv3 .fv3-table tr.click{cursor:pointer}.fv3 .fv3-table tr.click:hover td{background:rgba(255,255,255,.03)}
.fv3 .scroll{overflow-x:auto}
.fv3 .empty,.fv3 .errorbox{border:1px dashed var(--border);border-radius:12px;padding:28px 18px;text-align:center;color:var(--muted);display:flex;flex-direction:column;gap:10px;align-items:center}
.fv3 .errorbox{border-color:var(--bad);color:var(--text)}
.fv3 .skel{border-radius:8px;background:linear-gradient(90deg,#1c2327,#262f34,#1c2327);background-size:200% 100%;animation:fv3sk 1.2s linear infinite;min-height:18px}
@keyframes fv3sk{to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.fv3 .skel{animation:none}}
.fv3 .overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px;overflow-y:auto;z-index:1000}
.fv3 .dialog{background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:640px;display:flex;flex-direction:column;gap:14px;padding:18px 20px}
.fv3 .dialog.wide{max-width:900px}
.fv3 .dialog .foot{display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end;border-top:1px solid var(--rule);padding-top:12px}
.fv3 .timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0}
.fv3 .timeline li{display:grid;grid-template-columns:150px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid var(--rule)}
.fv3 .tag{font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;padding:1px 7px;border-radius:6px}
.fv3 .tag.money{background:rgba(52,216,160,.14);color:var(--ok)}.fv3 .tag.email{background:rgba(119,161,255,.14);color:var(--info)}.fv3 .tag.doc{background:rgba(242,166,90,.14);color:var(--warn)}
.fv3 .kv{display:grid;grid-template-columns:minmax(120px,200px) 1fr;gap:6px 14px}.fv3 .kv dt{color:var(--muted)}.fv3 .kv dd{margin:0;overflow-wrap:anywhere}
.fv3 .toasts{position:fixed;bottom:16px;right:16px;display:flex;flex-direction:column;gap:8px;z-index:1100;max-width:min(380px,calc(100vw - 32px))}
.fv3 .toast{background:var(--raised);border:1px solid var(--border);border-left:4px solid var(--ok);border-radius:10px;padding:10px 14px}
.fv3 .toast.bad{border-left-color:var(--bad)}
.fv3 .mode{display:inline-flex;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.fv3 .mode button{appearance:none;border:0;background:transparent;color:var(--muted);padding:7px 16px;font:inherit;font-weight:600;cursor:pointer;min-height:36px}
.fv3 .mode button[aria-pressed=true]{background:var(--accent);color:#06222f}
.fv3 pre.copy{margin:0;background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px}
.fv3 .totals td{font-weight:700;border-top:2px solid var(--border)}
@media (max-width:720px){
  .fv3 .timeline li{grid-template-columns:1fr;gap:4px}
  .fv3 .kv{grid-template-columns:1fr;gap:0}.fv3 .kv dd{margin-bottom:8px}
  .fv3 .stat.hero .v{font-size:24px}
  .fv3 .dialog{padding:16px 14px;border-radius:12px}.fv3 .overlay{padding:2vh 8px}
  .fv3 table.fv3-table.cards thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .fv3 table.fv3-table.cards,.fv3 table.fv3-table.cards tbody,.fv3 table.fv3-table.cards tr,.fv3 table.fv3-table.cards td{display:block;width:100%}
  .fv3 table.fv3-table.cards tr{border:1px solid var(--border);border-radius:10px;margin-bottom:10px;padding:6px 10px;background:var(--surface)}
  .fv3 table.fv3-table.cards td{border:0;padding:4px 0;display:flex;justify-content:space-between;gap:12px;text-align:right}
  .fv3 table.fv3-table.cards td::before{content:attr(data-label);color:var(--muted);text-align:left;flex:0 0 40%}
  .fv3 table.fv3-table.cards td.num{text-align:right}
}
`;
