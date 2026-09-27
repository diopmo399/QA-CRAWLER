/**
 * Description sérialisable de la façon de retrouver un élément. Jamais un Locator
 * Playwright : décisions, graphes et rapports doivent rester des données simples
 * (enregistrables en JSON, transmissibles à un futur moteur de décision).
 *
 * Ordre de préférence à la construction : testId → rôle + nom accessible →
 * libellé → texte → css (dernier recours).
 */
export type LocatorStrategy = 'testId' | 'role' | 'label' | 'text' | 'css';

export interface LocatorDescriptor {
  strategy: LocatorStrategy;
  /** Rôle ARIA, pour la stratégie `role`. */
  role?: string;
  /** Nom accessible, pour la stratégie `role`. */
  name?: string;
  /** testId, texte du libellé, texte visible ou sélecteur CSS, selon la stratégie. */
  value?: string;
  /** Correspondance exacte (casse respectée, chaîne entière). */
  exact?: boolean;
  /** Index à partir de 0 quand le descripteur correspond à plusieurs éléments de la page. */
  nth?: number;
}

export function describeLocator(locator: LocatorDescriptor): string {
  const nth = locator.nth !== undefined && locator.nth > 0 ? ` [${locator.nth}]` : '';
  switch (locator.strategy) {
    case 'role':
      return `role=${locator.role ?? '?'}[name="${locator.name ?? ''}"]${nth}`;
    case 'testId':
      return `testId=${locator.value ?? ''}${nth}`;
    case 'label':
      return `label="${locator.value ?? ''}"${nth}`;
    case 'text':
      return `text="${locator.value ?? ''}"${nth}`;
    case 'css':
      return `css=${locator.value ?? ''}${nth}`;
  }
}
