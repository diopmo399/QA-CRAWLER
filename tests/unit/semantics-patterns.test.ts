import { describe, expect, it } from 'vitest';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { RuleBasedPatternDetector } from '../../src/patterns/pattern-detector.js';
import { patternInterest } from '../../src/patterns/pattern-rules.js';
import { loadDomainPacks, loadSemantics, semanticsOf } from '../../src/semantics/domain-packs.js';
import { SemanticDictionary, singularWords } from '../../src/semantics/semantic-dictionary.js';
import { button, field, link, screen, structure } from '../helpers.js';

describe('SemanticDictionary', () => {
  const dictionary = new SemanticDictionary({
    concepts: { create: ['enrôler'] },
    synonyms: { users: ['utilisateur', 'membres'] },
  });

  it('matches concepts in French and English, accents and case ignored', () => {
    expect(dictionary.match('create', 'Créer un utilisateur')).toBe('creer');
    expect(dictionary.match('create', 'Add user')).toBe('add');
    expect(dictionary.match('create', 'Nouvelle demande')).toBe('nouvelle');
    expect(dictionary.match('create', 'Enrôler')).toBe('enroler');
    expect(dictionary.match('delete', 'Supprimer')).toBeDefined();
    expect(dictionary.match('cancel', 'Annuler')).toBe('annuler');
    expect(dictionary.match('create', 'Created at')).toBeUndefined(); // mots entiers
    expect(dictionary.conceptsIn('Enregistrer et continuer')).toEqual(
      expect.arrayContaining(['save', 'next']),
    );
  });

  it('mission terms: synonyms and simple plurals', () => {
    expect(dictionary.mentions('users', 'Gestion des utilisateurs')).toBe(true);
    expect(dictionary.mentions('users', 'Nos membres')).toBe(true);
    expect(dictionary.mentions('users', 'User list')).toBe(true);
    expect(dictionary.mentions('users', 'Paramètres')).toBe(false);
    expect(dictionary.mentions('create-user', 'Create user')).toBe(true);
    expect(singularWords('Utilisateurs actifs')).toBe('utilisateur actif');
  });

  it('only the words a mission or pack added can reach the safety policy', () => {
    expect(dictionary.addedWords('create')).toEqual(['enrôler']);
    expect(dictionary.addedWords('delete')).toEqual([]);
  });
});

describe('domain packs', () => {
  it('loads the built-in packs; the mission has the last word', async () => {
    const packs = await loadDomainPacks(['generic', 'administration', 'ecommerce']);
    expect(packs.map((pack) => pack.name)).toEqual(['generic', 'administration', 'ecommerce']);
    const semantics = semanticsOf(
      { semantics: { concepts: {}, synonyms: { users: ['agents terrain'] } } },
      packs,
    );
    expect(semantics.dictionary.mentions('users', 'Liste des comptes')).toBe(true); // generic
    expect(semantics.dictionary.mentions('users', 'Agents terrain')).toBe(true); // mission
    expect(semantics.dictionary.match('deactivate', 'Désactiver le compte')).toBeDefined(); // administration
    expect(semantics.invariants.map((rule) => rule.id)).toContain('NO-SERVER-ERROR');
    expect(semantics.patternRules.DETAIL?.assign).toBe(30);
  });

  it('an unknown or invalid pack is an explicit error', async () => {
    await expect(
      loadSemantics({ domainPacks: ['nope'], semantics: { concepts: {}, synonyms: {} } }),
    ).rejects.toThrow('domain pack "nope" not found');
  });
});

describe('PatternDetector', () => {
  const detector = new RuleBasedPatternDetector();
  const types = (patterns: { type: string }[]): string[] => patterns.map((pattern) => pattern.type);

  it('CRUD_LIST from a table + create button + per-row links + pagination, with the evidence', () => {
    const context = screen({
      url: 'http://localhost:4200/users',
      headings: ['Utilisateurs'],
      elements: [
        button('Ajouter un utilisateur'),
        link('Voir', 'http://localhost:4200/users/1'),
        link('Voir', 'http://localhost:4200/users/2'),
        link('Voir', 'http://localhost:4200/users/3'),
        field('Rechercher', { role: 'searchbox', inputType: 'search', inSearchForm: true }),
      ],
      structure: structure({ tables: 1, tableRows: 3, columnHeaders: ['Nom', 'Rôle'], pagination: true }),
    });
    const patterns = detector.detect(context);
    const crud = patterns.find((pattern) => pattern.type === 'CRUD_LIST');
    expect(crud?.confidence).toBeGreaterThan(0.8);
    expect(crud?.evidence).toEqual(
      expect.arrayContaining(['table (Nom, Rôle)', '3 row(s)', 'button "Ajouter un utilisateur" (create)']),
    );
    expect(types(patterns)).toEqual(expect.arrayContaining(['SEARCH', 'PAGINATION']));
  });

  it('never from the text of a button alone', () => {
    const patterns = detector.detect(
      screen({ elements: [button('Ajouter'), button('Suivant'), button('Rechercher')] }),
    );
    expect(types(patterns)).not.toEqual(expect.arrayContaining(['CRUD_LIST']));
    expect(types(patterns)).not.toContain('WIZARD');
    expect(types(patterns)).not.toContain('SEARCH');
  });

  it('LOGIN, ERROR_PAGE, WIZARD (« Étape 2 sur 3 »), CONFIRMATION_DIALOG, EMPTY_STATE', () => {
    expect(
      types(
        detector.detect(
          screen({
            title: 'Connexion',
            elements: [
              field('Identifiant'),
              field('Mot de passe', { inputType: 'password' }),
              button('Se connecter'),
            ],
          }),
        ),
      ),
    ).toContain('LOGIN');
    expect(
      types(
        detector.detect(
          screen({
            title: 'Erreur',
            headings: ['404 — Page introuvable'],
            elements: [link('Accueil', 'http://localhost:4200/')],
          }),
        ),
      ),
    ).toContain('ERROR_PAGE');
    expect(
      types(
        detector.detect(
          screen({
            headings: ['Nouveau dossier', 'Étape 2 sur 3'],
            elements: [field('Montant'), button('Précédent'), button('Suivant')],
            structure: structure({ wizardSteps: 3 }),
          }),
        ),
      ),
    ).toContain('WIZARD');
    expect(
      types(
        detector.detect(
          screen({
            dialogs: ['Confirmer la suppression'],
            elements: [
              button('Supprimer', {
                inDialog: true,
                dialogName: 'Confirmer la suppression',
                foreground: true,
              }),
              button('Annuler', { inDialog: true, dialogName: 'Confirmer la suppression', foreground: true }),
            ],
          }),
        ),
      ),
    ).toContain('CONFIRMATION_DIALOG');
    expect(
      types(
        detector.detect(
          screen({
            elements: [button('Créer')],
            structure: structure({ tables: 1, tableRows: 0, emptyMessage: 'Aucun résultat' }),
          }),
        ),
      ),
    ).toContain('EMPTY_STATE');
  });
});

/** L'action n° `index` d'un écran (échoue clairement si elle n'existe pas). */
function at(context: PageContext, index: number): DiscoveredAction {
  const action = context.actions[index];
  if (!action) throw new Error(`no action #${index}`);
  return action;
}

describe('pattern rules', () => {
  const dictionary = new SemanticDictionary();
  const crud = [{ type: 'CRUD_LIST' as const, confidence: 1, evidence: [] }];

  it('CRUD_LIST: create +80, delete BLOCK; weighted by the confidence of the pattern', () => {
    const page = screen({ elements: [button('Nouvel utilisateur'), button('Supprimer')] });
    expect(patternInterest(at(page, 0), crud, dictionary)).toMatchObject({
      points: 80,
      reasons: [{ pattern: 'CRUD_LIST', rule: 'create', points: 80 }],
    });
    expect(
      patternInterest(at(page, 0), [{ type: 'CRUD_LIST', confidence: 0.5, evidence: [] }], dictionary).points,
    ).toBe(40);
    expect(patternInterest(at(page, 1), crud, dictionary).blocked).toEqual({
      pattern: 'CRUD_LIST',
      rule: 'delete',
    });
  });

  it('WIZARD: next +80, cancel -40; a domain pack adds hints without lifting a BLOCK', () => {
    const wizard = [{ type: 'WIZARD' as const, confidence: 1, evidence: [] }];
    const page = screen({ elements: [button('Continuer'), button('Annuler'), button('Supprimer')] });
    expect(patternInterest(at(page, 0), wizard, dictionary).points).toBe(80);
    expect(patternInterest(at(page, 1), wizard, dictionary).points).toBe(-40);
    expect(
      patternInterest(at(page, 2), crud, dictionary, { CRUD_LIST: { delete: 50 } }).blocked,
    ).toBeDefined();
  });
});
