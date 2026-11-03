import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeAngular } from '../../src/incident/code/angular.js';
import { guardedFiles } from '../../src/incident/guarded-fs.js';
import { ScopePolicy } from '../../src/incident/scope-policy.js';
import { defaultScope } from '../../src/incident/scope.js';
import {
  accessPath,
  entryActions,
  locateTarget,
  preparationOf,
  targetCandidates,
} from '../../src/incident/target-screen.js';
import type { AngularModel, UiSnapshot } from '../../src/sdk/core/incident-trigger-contracts.js';

/**
 * LOCALISER L'ÉCRAN CIBLE DANS LE CODE : routes (redirection, gardes, paramètres), liens des templates et
 * titres relevés par l'analyse Angular ; candidats notés sur des indices cités (un nom seul reste incertain,
 * plafonné à 0,45) ; parcours par liens depuis l'entrée (les liens de la coquille valent partout), étapes
 * guidées rapprochées des liens ; gardes et routes paramétrées dites comme limites, jamais contournées ;
 * l'inventaire d'un écran atteint (page de connexion détectée, aucune valeur gardée).
 */
const FIXTURE = path.resolve('tests/fixtures/angular-app');
const at = '2026-11-02T10:00:00.000Z';
let fixture: AngularModel;
let guarded: AngularModel;
let temp: string;

async function modelOf(root: string): Promise<AngularModel> {
  const scope = defaultScope({
    applications: [{ id: 'web', name: 'web', layer: 'FRONTEND', repository: { root, include: ['src'] } }],
  });
  return analyzeAngular(scope.applications[0] as never, guardedFiles(new ScopePolicy(scope)));
}

beforeAll(async () => {
  fixture = await modelOf(FIXTURE);
  // Une application avec une coquille (menu global), une garde, une route enfant et une route paramétrée.
  temp = await mkdtemp(path.join(tmpdir(), 'target-screen-'));
  const app = path.join(temp, 'src', 'app');
  await mkdir(app, { recursive: true });
  await writeFile(
    path.join(app, 'app.routes.ts'),
    `import { Routes } from '@angular/router';
import { AccueilComponent } from './accueil.component';
import { AdminComponent } from './admin.component';
import { ReglagesComponent } from './reglages.component';
import { FactureComponent } from './facture.component';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: 'accueil', component: AccueilComponent },
  { path: 'admin', component: AdminComponent, canActivate: [authGuard] },
  { path: 'admin/reglages', component: ReglagesComponent },
  { path: 'factures/:id', component: FactureComponent },
  { path: '', redirectTo: 'accueil', pathMatch: 'full' },
];
`,
  );
  await writeFile(
    path.join(app, 'app.component.ts'),
    `import { Component } from '@angular/core';
@Component({
  selector: 'app-root',
  standalone: true,
  template: \`<nav><a routerLink="/admin">Administration</a></nav><router-outlet></router-outlet>\`,
})
export class AppComponent {}
`,
  );
  const screen = (name: string, title: string, extra = ''): string =>
    `import { Component } from '@angular/core';
@Component({ selector: 'app-${name.toLowerCase()}', standalone: true, template: \`<h1>${title}</h1>${extra}\` })
export class ${name}Component {}
`;
  await writeFile(path.join(app, 'accueil.component.ts'), screen('Accueil', 'Accueil'));
  await writeFile(
    path.join(app, 'admin.component.ts'),
    screen('Admin', 'Administration', '<a routerLink="/admin/reglages">Réglages avancés</a>'),
  );
  await writeFile(path.join(app, 'reglages.component.ts'), screen('Reglages', 'Réglages avancés'));
  await writeFile(path.join(app, 'facture.component.ts'), screen('Facture', 'Détail de la facture'));
  guarded = await modelOf(temp);
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

const input = (query: string, over: Partial<Parameters<typeof locateTarget>[0]> = {}) => ({
  query,
  models: [fixture],
  actor: 'alice',
  at,
  ...over,
});

describe('localisation de l’écran cible', () => {
  it('l’analyse Angular relève routes (redirection), liens et titres', () => {
    const navigation = fixture.navigation;
    expect(navigation?.routes.map((route) => route.path).sort()).toEqual([
      '',
      'dossiers',
      'dossiers/nouveau',
    ]);
    expect(navigation?.routes.find((route) => route.path === '')?.redirectTo).toBe('dossiers');
    expect(navigation?.links.map((link) => `${link.label} → ${link.target}`)).toEqual(
      expect.arrayContaining(['Nouveau dossier → /dossiers/nouveau', 'Liste des dossiers → /dossiers']),
    );
    expect(navigation?.headings.map((heading) => heading.text)).toEqual(
      expect.arrayContaining(['Dossiers', 'Nouveau dossier']),
    );
    expect(guarded.navigation?.routes.find((route) => route.path === 'admin')?.guards).toEqual(['authGuard']);
  });

  it('par le nom de l’écran : lien entrant et titre citent la preuve ; un nom seul reste plafonné', () => {
    const [best, second] = targetCandidates(input('création d’un nouveau dossier'));
    expect(best).toMatchObject({
      route: '/dossiers/nouveau',
      component: 'DossierComponent',
      nameOnly: false,
    });
    expect(best?.confidence).toBeGreaterThan(0.8);
    expect(best?.evidence.join(' | ')).toMatch(/lien « Nouveau dossier ».*titre « Nouveau dossier »/);
    expect(second?.route).toBe('/dossiers');
    // « liste » ne figure dans aucun lien de la liste vers elle-même, mais dans le lien « Liste des dossiers ».
    expect(targetCandidates(input('liste des dossiers'))[0]?.route).toBe('/dossiers');
    // Un mot présent seulement dans un nom de composant : jamais plus de 0,45.
    const weak = targetCandidates(input('component'));
    expect(weak.every((candidate) => candidate.nameOnly && candidate.confidence <= 0.45)).toBe(true);
    expect(targetCandidates(input('facturation mensuelle'))).toEqual([]);
  });

  it('par l’URL : la route correspondante gagne, même sans mot commun', () => {
    const [best] = targetCandidates(input('écran inconnu', { url: 'https://app.test/dossiers/nouveau?x=1' }));
    expect(best?.route).toBe('/dossiers/nouveau');
    expect(best?.evidence[0]).toMatch(/l’URL indiquée correspond à la route \/dossiers\/nouveau/);
  });

  it('le parcours : entrée par la redirection de la racine, puis le lien relevé', () => {
    const route = accessPath([fixture], '/dossiers/nouveau');
    expect(route.entry).toBe('/dossiers');
    expect(route.path.map((step) => `${step.kind} ${step.target} (${step.source})`)).toEqual([
      'NAVIGATE /dossiers (LINKS)',
      'CLICK link:Nouveau dossier (LINKS)',
    ]);
    expect(route.limits).toEqual([]);
    // Étapes guidées : rapprochées d'un lien ; une étape sans lien est gardée comme indication.
    const guided = accessPath([fixture], '/dossiers/nouveau', {
      steps: ['Cliquer sur Nouveau dossier', 'Ouvrir le menu Archives'],
    });
    expect(guided.path.map((step) => step.source)).toEqual(['LINKS', 'GUIDED']);
    expect(guided.limits.join(' ')).toMatch(/Archives/);
    // Le départ d'un enregistrement, quand c'est une route connue, sert d'entrée.
    const recorded = accessPath([fixture], '/dossiers/nouveau', { recordingStart: '/dossiers' });
    expect(recorded.path[0]?.source).toBe('RECORDING');
  });

  it('les liens de la coquille valent partout ; gardes et routes paramétrées sont des limites', () => {
    const admin = locateTarget({ query: 'réglages avancés', models: [guarded], actor: 'alice', at });
    expect(admin.chosen).toBe('/admin/reglages');
    expect(admin.path.map((step) => `${step.kind} ${step.target}`)).toEqual([
      'NAVIGATE /accueil',
      'CLICK link:Administration',
      'CLICK link:Réglages avancés',
    ]);
    // La garde de la route parente vaut aussi pour l'enfant : dite, jamais contournée.
    expect(admin.guards).toEqual(['authGuard']);
    expect(admin.limits.join(' ')).toMatch(/accès protégé par authGuard.*ne contourne pas la garde/);
    const invoice = locateTarget({ query: 'détail de la facture', models: [guarded], actor: 'alice', at });
    expect(invoice.chosen).toBe('/factures/:id');
    expect(invoice.limits.join(' ')).toMatch(/route paramétrée \/factures\/:id/);
    // Aucun lien n'y mène : accès direct proposé et dit.
    expect(invoice.path.at(-1)?.source).toBe('DIRECT');
    expect(invoice.limits.join(' ')).toMatch(/aucun lien relevé/);
  });

  it('un écran choisi par la personne ; aucune route lue : la limite est dite', () => {
    const forced = locateTarget(input('nouveau dossier', { route: 'dossiers' }));
    expect(forced.chosen).toBe('/dossiers');
    expect(forced.candidates[0]?.route).toBe('/dossiers/nouveau');
    const empty = locateTarget({ query: 'nouveau dossier', models: [], actor: 'alice', at });
    expect(empty.chosen).toBeUndefined();
    expect(empty.limits.join(' ')).toMatch(/aucune route Angular lue/);
  });

  it('les actions du moteur : navigation absolue, clic sur le lien ; origine « target »', () => {
    const route = accessPath([fixture], '/dossiers/nouveau');
    expect(entryActions(route.path, 'http://site.test/')).toEqual([
      { kind: 'NAVIGATE', target: 'http://site.test/dossiers', origin: 'target' },
      { kind: 'CLICK', target: 'link:Nouveau dossier', origin: 'target' },
    ]);
  });

  it('l’inventaire de l’écran atteint ; une page de connexion bloque ; un autre écran est dit', () => {
    const snapshot = (over: Partial<UiSnapshot> = {}): UiSnapshot => ({
      url: '/dossiers/nouveau',
      title: 'Nouveau dossier',
      elements: [
        { key: 'b1', role: 'button', name: 'Enregistrer', enabled: true, visible: true },
        { key: 'b2', role: 'button', name: 'Notes', enabled: false, visible: true },
        { key: 'f1', role: 'textbox', name: 'Code', enabled: true, visible: true, value: '••••' },
        { key: 'h1', role: 'button', name: 'Caché', enabled: true, visible: false },
      ],
      overlays: 0,
      messages: [],
      loading: false,
      ...over,
    });
    const base = {
      route: '/dossiers/nouveau',
      steps: [{ summary: 'naviguer', ok: true }],
      events: [
        { id: 'e1', t: 1, at, kind: 'REQUEST' as const, summary: 'GET /dossiers' },
        { id: 'e2', t: 2, at, kind: 'CONSOLE' as const, level: 'error' as const, summary: 'boom' },
      ],
      blockers: [],
      actor: 'alice',
      at,
      durationMs: 1200,
    };
    const ok = preparationOf({ ...base, snapshot: snapshot() });
    expect(ok.reached).toBe(true);
    expect(ok.inventory.buttons).toEqual(['Enregistrer', 'Notes']);
    expect(ok.inventory.fields).toEqual(['Code']);
    expect(ok.inventory.disabled).toEqual(['button:Notes']);
    expect(ok.requests).toEqual(['GET /dossiers']);
    expect(ok.errors).toEqual(['boom']);
    expect(JSON.stringify(ok)).not.toContain('••••');
    const login = preparationOf({
      ...base,
      snapshot: snapshot({
        url: '/connexion',
        elements: [{ key: 'p', role: 'textbox', name: 'Mot de passe', enabled: true, visible: true }],
      }),
    });
    expect(login.reached).toBe(false);
    expect(login.blockers.join(' ')).toMatch(/écran atteint \/connexion au lieu de \/dossiers\/nouveau/);
    expect(login.blockers.join(' ')).toMatch(/page de connexion.*aucun identifiant n’est saisi/);
    const failed = preparationOf({
      ...base,
      steps: [{ summary: 'cliquer', ok: false }],
      snapshot: snapshot(),
    });
    expect(failed.reached).toBe(false);
  });
});
