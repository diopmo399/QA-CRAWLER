/**
 * LE THÈME QA-CRAWLER, partagé par toutes les pages : la vue d'ensemble, le rapport du run, le graphe
 * des flows, le rapport d'enregistrement, le dry-run et la fenêtre du recorder.
 *
 * Clair par défaut, sombre au choix (bouton dans l'en-tête), le choix gardé pour toutes les pages
 * (localStorage `qa-crawler-theme`). Les couleurs passent toutes par des variables CSS : une page
 * déclare ses composants avec `var(--…)` et suit le thème sans rien savoir de lui.
 */

/** La clé du choix de thème, commune à toutes les pages. */
export const THEME_STORAGE_KEY = 'qa-crawler-theme';

/** Les jetons de couleur : `:root` (clair) et `:root[data-theme="dark"]` (sombre). */
export const THEME_TOKENS_CSS = `
:root{color-scheme:light;
--bg:#F5F6FA;--chrome:#FFFFFF;--surface:#FFFFFF;--surface-2:#F8FAFC;--border:#E4E7EF;--border-strong:#D6DAE4;--text:#111827;--text-2:#374151;--muted:#5B6478;
--accent:#4F46E5;--accent-2:#7C3AED;--accent-ink:#4338CA;--accent-soft:#EEF2FF;--nav-hover:#F1F2F8;--shadow:0 1px 2px rgba(16,24,40,.05);
--ok:#16A34A;--ok-bg:#F0FDF4;--ok-border:#BBF7D0;--ok-soft:#DCFCE7;--ok-ink:#15803D;
--warn:#F59E0B;--warn-bg:#FFFBEB;--warn-border:#F59E0B;--warn-soft:#FEF3C7;--warn-ink:#92400E;
--purple:#8B5CF6;--purple-bg:#F5F3FF;--purple-border:#C4B5FD;--purple-soft:#EDE9FE;--purple-ink:#5B21B6;
--blue:#3B82F6;--blue-bg:#EFF6FF;--blue-border:#93C5FD;--blue-soft:#DBEAFE;--blue-ink:#1D4ED8;
--red:#DC2626;--red-bg:#FEF2F2;--red-border:#FECACA;--red-soft:#FEE2E2;--red-ink:#B91C1C;
--grey-soft:#F1F2F8;--grey-ink:#4B5563;--link:#94A3B8;--code-bg:#0F172A;--code-text:#E2E8F0}
:root[data-theme="dark"]{color-scheme:dark;
--bg:#080B14;--chrome:#0A0E19;--surface:#111726;--surface-2:#0D1220;--border:#1F2638;--border-strong:#2A3248;--text:#E6E9F2;--text-2:#C9CFDD;--muted:#9AA3B8;
--accent:#5B4BD8;--accent-2:#8B5CF6;--accent-ink:#A5B4FC;--accent-soft:#1C1A4A;--nav-hover:#161C2D;--shadow:none;
--ok:#22C55E;--ok-bg:#0F1A1B;--ok-border:#1E4B33;--ok-soft:#0E3B22;--ok-ink:#4ADE80;
--warn:#F59E0B;--warn-bg:#1E1610;--warn-border:#B45309;--warn-soft:#451A03;--warn-ink:#FCD34D;
--purple:#8B5CF6;--purple-bg:#17163A;--purple-border:#6D5BD0;--purple-soft:#2E1F6B;--purple-ink:#DDD6FE;
--blue:#3B82F6;--blue-bg:#0F1B3A;--blue-border:#1D4ED8;--blue-soft:#1E3A8A;--blue-ink:#BFDBFE;
--red:#EF4444;--red-bg:#2A1215;--red-border:#7F1D1D;--red-soft:#450A0A;--red-ink:#FCA5A5;
--grey-soft:#1A2133;--grey-ink:#A9B1C4;--link:#64748B;--code-bg:#05070D;--code-text:#E2E8F0}
`;

/** La police et les éléments communs (marque, bouton de thème). */
export const THEME_BASE_CSS = `
.qa-brand{display:flex;align-items:center;gap:12px;min-width:0}
.qa-brand-name{font-weight:800;font-size:20px;letter-spacing:.02em;color:var(--text);line-height:1.15}
.qa-brand-tag{font-size:12px;color:var(--muted)}
.qa-theme-toggle{position:relative;width:44px;height:44px;display:inline-grid;place-items:center;border:0;border-radius:10px;background:transparent;color:var(--text-2);cursor:pointer;padding:0;flex:none}
.qa-theme-toggle:hover{background:var(--nav-hover)}
.qa-theme-toggle svg{width:22px;height:22px}
.qa-theme-toggle .qa-sun{display:none}
:root[data-theme="dark"] .qa-theme-toggle .qa-sun{display:block}
:root[data-theme="dark"] .qa-theme-toggle .qa-moon{display:none}
`;

/** À mettre dans <head>, avant les styles : applique le thème choisi sans flash. */
export const THEME_BOOT_SCRIPT = `<script>try{var qaTheme=localStorage.getItem('${THEME_STORAGE_KEY}');if(qaTheme==='dark'||qaTheme==='light')document.documentElement.dataset.theme=qaTheme;}catch(e){}</script>`;

/** À mettre en fin de <body> : branche chaque bouton `.qa-theme-toggle`. */
export const THEME_TOGGLE_SCRIPT = `<script>(function(){var root=document.documentElement;function sync(){document.querySelectorAll('.qa-theme-toggle').forEach(function(b){var dark=root.dataset.theme==='dark';b.setAttribute('aria-pressed',String(dark));b.setAttribute('aria-label',dark?b.dataset.light:b.dataset.dark);b.title=b.getAttribute('aria-label');});}document.querySelectorAll('.qa-theme-toggle').forEach(function(b){b.addEventListener('click',function(){root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';try{localStorage.setItem('${THEME_STORAGE_KEY}',root.dataset.theme);}catch(e){}sync();});});sync();})();</script>`;

const TOGGLE_LABELS = {
  fr: { dark: 'Thème sombre', light: 'Thème clair' },
  en: { dark: 'Dark theme', light: 'Light theme' },
} as const;

/** Le bouton clair / sombre (lune en clair, soleil en sombre). */
export function themeToggle(language: 'fr' | 'en', id?: string): string {
  const labels = TOGGLE_LABELS[language];
  return `<button type="button" class="qa-theme-toggle"${id ? ` id="${id}"` : ''} aria-label="${labels.dark}" data-dark="${labels.dark}" data-light="${labels.light}"><svg class="qa-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg><svg class="qa-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`;
}

/** Le logo QA-CRAWLER (loupe bleu → violet). */
export function brandLogo(size = 36): string {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="qa-logo-${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B82F6"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><circle cx="17" cy="17" r="11" fill="none" stroke="url(#qa-logo-${size})" stroke-width="6"/><path d="M24 24l7 7" stroke="#8B5CF6" stroke-width="6" stroke-linecap="round"/></svg>`;
}

/** La marque : logo, « QA-CRAWLER » et une ligne en dessous (slogan ou nom de la page). */
export function brandBlock(tagline: string, size = 36): string {
  return `<div class="qa-brand">${brandLogo(size)}<div><div class="qa-brand-name">QA-CRAWLER</div><div class="qa-brand-tag">${tagline}</div></div></div>`;
}
