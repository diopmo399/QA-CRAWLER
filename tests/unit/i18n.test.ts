import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { reportTexts, translateReason, valueLabel } from '../../src/reporting/i18n.js';

describe('report language', () => {
  it('defaults to English and accepts fr', () => {
    const base = 'target:\n  baseUrl: http://localhost:4200\n';
    expect(parseConfig(base, {}, {}).config.report.language).toBe('en');
    expect(parseConfig(`${base}report:\n  language: fr\n`, {}, {}).config.report.language).toBe('fr');
    expect(() => parseConfig(`${base}report:\n  language: de\n`, {}, {})).toThrowError(/report\.language/);
  });

  it('translates statuses, classes and severities in French only', () => {
    expect(valueLabel('fr', 'PASSED')).toBe('RÉUSSI');
    expect(valueLabel('fr', 'BLOCKED')).toBe('BLOQUÉ');
    expect(valueLabel('fr', 'DANGEROUS')).toBe('DANGEREUSE');
    expect(valueLabel('fr', 'WARNING')).toBe('AVERTISSEMENT');
    expect(valueLabel('fr', 'click')).toBe('clic');
    expect(valueLabel('fr', 'something-else')).toBe('something-else');
    expect(valueLabel('en', 'PASSED')).toBe('PASSED');
    expect(reportTexts('fr').flowsTitle).toBe('Flows imposés');
  });

  it('translates the safety and flow reasons, nested ones included', () => {
    expect(
      translateReason(
        'fr',
        'MUTATION action (matches mutation keyword "enregistrer"): add "allow: MUTATION" to this step to execute it',
      ),
    ).toBe(
      'action de MODIFICATION (mot-clé de modification « enregistrer ») : ajoutez « allow: MUTATION » à cette étape pour l’exécuter',
    );
    expect(
      translateReason('fr', 'DANGEROUS actions are never executed (matches dangerous keyword "supprimer")'),
    ).toBe('les actions DANGEREUSES ne sont jamais exécutées (mot-clé dangereux « supprimer »)');
    expect(translateReason('fr', 'element not found within 5000 ms')).toBe(
      'élément introuvable après 5000 ms',
    );
    expect(translateReason('fr', 'step 1 failed')).toBe('étape 1 échouée');
    expect(translateReason('fr', 'navigation refused: external-host (evil.example.com)')).toBe(
      'navigation refusée : hôte externe (evil.example.com)',
    );
    expect(
      translateReason(
        'fr',
        'Flow "connexion" — step 3 "click role=button[name="OK"]" blocked: submits a form',
      ),
    ).toBe('Flow « connexion » — étape 3 « click role=button[name="OK"] » bloquée : envoie un formulaire');
    // Unknown text (browser messages) is left as is; English is never changed.
    expect(translateReason('fr', 'TypeError: x is undefined')).toBe('TypeError: x is undefined');
    expect(translateReason('en', 'step 1 failed')).toBe('step 1 failed');
  });
});
