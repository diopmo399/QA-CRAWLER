/**
 * LE THÈME SOMBRE des composants du SDK, par l'attribut `theme` de l'élément :
 *
 *   theme absent ou "light"   le thème clair (défaut, inchangé) ;
 *   theme="dark"              le thème sombre ;
 *   theme="auto"              suit `prefers-color-scheme` du système.
 *
 * Seuls les jetons `--qa-*` changent (plus les rares couleurs écrites en dur sur un fond clair). Une
 * variable posée par l'hôte sur l'élément l'emporte toujours sur ces valeurs, dans les deux thèmes.
 */
const DARK_TOKENS = [
  '--qa-color-primary:#4FBF86',
  '--qa-color-primary-2:#7ED8A8',
  '--qa-color-secondary:#3FAE76',
  '--qa-color-primary-soft:#143D2B',
  '--qa-color-primary-soft-2:#0F2E21',
  '--qa-color-background:#0C1512',
  '--qa-color-surface:#13201B',
  '--qa-color-surface-2:#192B24',
  '--qa-color-text:#E6F0EA',
  '--qa-color-muted:#A3B8AC',
  '--qa-color-faint:#7E9488',
  '--qa-color-border:#24392F',
  '--qa-color-border-strong:#345244',
  '--qa-color-panel:#06201A',
  '--qa-color-panel-2:#0B2E24',
  '--qa-color-panel-raised:#0F3A2D',
  '--qa-color-panel-border:#1B4A3A',
  '--qa-color-panel-hover:#12402F',
  '--qa-color-panel-text:#F2FAF5',
  '--qa-color-panel-muted:#9CCDB3',
  '--qa-color-panel-link:#8FE0B5',
  '--qa-color-success:#4FBF86',
  '--qa-color-success-soft:#10362A',
  '--qa-color-warning:#F2B24C',
  '--qa-color-warning-soft:#3A2B10',
  '--qa-color-danger:#FF7A7E',
  '--qa-color-danger-soft:#3E1A1E',
  '--qa-color-data:#6AAEFF',
  'color-scheme:dark',
].join(';');

/** Les sélecteurs (dans le Shadow DOM) qui prennent le thème sombre. */
const DARK_HOSTS = { dark: ':host([theme="dark"])', auto: ':host([theme="auto"])' };

/**
 * Le CSS du thème sombre d'un composant : les jetons, puis les règles propres au composant
 * (`[sélecteur, déclarations]`) pour ses couleurs écrites en dur sur un fond clair.
 */
export function darkThemeCss(rules: readonly (readonly [string, string])[] = []): string {
  const scoped = (host: string): string =>
    [
      `${host}{${DARK_TOKENS}}`,
      ...rules.map(([selector, declarations]) => `${host} ${selector}{${declarations}}`),
    ].join('\n');
  return `\n${scoped(DARK_HOSTS.dark)}\n@media (prefers-color-scheme:dark){\n${scoped(DARK_HOSTS.auto)}\n}\n`;
}
