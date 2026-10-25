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
  '--qa-color-primary:#8B8BFF',
  '--qa-color-primary-2:#A07CFF',
  '--qa-color-background:#0E1120',
  '--qa-color-surface:#161A2C',
  '--qa-color-surface-2:#1D2236',
  '--qa-color-text:#E7E9F5',
  '--qa-color-muted:#A6ABC6',
  '--qa-color-faint:#7F85A4',
  '--qa-color-border:#2B3050',
  '--qa-color-border-strong:#3D4370',
  '--qa-color-panel:#0B0D1C',
  '--qa-color-panel-2:#1C1850',
  '--qa-color-success:#3DDBB8',
  '--qa-color-success-soft:#10362F',
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
