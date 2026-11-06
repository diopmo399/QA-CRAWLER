import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CartographyConfig, MapStructure, StructureItem } from '../../src/sdk/core/cartography.js';
import { analyzeJava } from '../../src/cartography/analyze-java.js';
import { analyzeTemplates, membersOf, parseTemplate } from '../../src/cartography/analyze-template.js';
import { buildIndex, type CoverageContext, type MapIndex } from '../../src/cartography/explorer.js';
import { runScan } from '../../src/cartography/scan.js';
import { actionRows, conditionRows, elementSheet, structureOf } from '../../src/cartography/structure.js';
import { shownExpression } from '../../src/sdk/ui/dashboard-cartography-lanes.js';

/**
 * La structure conditionnelle : le gabarit Angular (conteneurs, boutons, conditions), les décisions Java
 * (méthodes booléennes, champs calculés), puis, sur le scan réel du mini-projet de test, la chaîne d'une
 * condition jusqu'à la méthode Backend et la donnée lue, et les actions d'un bouton jusqu'à l'API externe.
 * Ce qui n'est pas démontré reste « non déterminé », avec sa cause.
 */
const FIXTURE = path.resolve('tests/fixtures/cartography-conditions');
const config: CartographyConfig = {
  schema: 1,
  sources: (
    [
      ['front', 'FRONTEND'],
      ['bff', 'BFF'],
      ['backend', 'BACKEND'],
    ] as const
  ).map(([id, layer]) => ({ id, name: id, layer, path: path.join(FIXTURE, id), include: [], enabled: true })),
};
const cov: CoverageContext = {
  links: [],
  coverage: new Map(),
  issues: [],
  lastRuns: new Map(),
  decisions: [],
};
const file = (p: string, text: string) => ({ path: p, text, hash: '', bytes: text.length });

describe('gabarit Angular : conteneurs, boutons et conditions', () => {
  const html = `<form (ngSubmit)="save()">
  <section><h2>General</h2><input formControlName="kind"></section>
  @if (state.showCompany) {
    <section><h3>Company</h3><input formControlName="companyName"></section>
  } @else {
    <p>No company</p>
  }
  <div *ngIf="user?.isAdmin && flags.audit">
    <button type="button" (click)="audit()">Audit</button>
  </div>
  <section [hidden]="!hasPermission"><h3>Attachments</h3></section>
  <button type="submit">Save</button>
  <button type="button" [disabled]="!state.canValidate" (click)="validateRequest()">Validate</button>
  <button type="button" [disabled]="computeRisk(state.items) > limit">Save</button>
</form>`;
  const elements = parseTemplate('RequestComponent', html, 'request.component.html', 0);
  const byName = (name: string) => elements.filter((e) => e.name === name);

  it('un bloc @if devient la condition de son premier élément ; [hidden] se lit « visible si non »', () => {
    const company = byName('Company')[0];
    expect(company?.kind).toBe('CONTAINER');
    expect(company?.visibleWhen).toMatchObject({ expression: 'state.showCompany', how: 'if' });
    expect(company?.fields).toEqual(['companyName']);
    const attachments = byName('Attachments')[0];
    expect(attachments?.visibleWhen).toMatchObject({ expression: '!hasPermission', how: 'hidden' });
    expect(attachments?.visibleWhen?.loc.line).toBe(11);
  });

  it('un *ngIf composé garde son expression brute ; le bouton dedans a ce conteneur pour parent', () => {
    const audit = byName('Audit')[0];
    expect(audit?.kind).toBe('BUTTON');
    expect(audit?.handler).toBe('audit');
    const parent = elements.find((e) => e.id === audit?.parent);
    expect(parent?.visibleWhen).toMatchObject({ expression: 'user?.isAdmin && flags.audit', how: 'ngIf' });
  });

  it('[disabled] et (click) ; un bouton submit appelle le gestionnaire du formulaire', () => {
    const validate = byName('Validate')[0];
    expect(validate?.disabledWhen).toMatchObject({ expression: '!state.canValidate', how: 'disabled' });
    expect(validate?.handler).toBe('validateRequest');
    const [submit] = byName('Save');
    expect(submit?.handler).toBe('save');
    expect(submit?.submit).toBe(true);
  });

  it('les homonymes restent deux éléments distincts (identifiants et conditions propres)', () => {
    const saves = byName('Save');
    expect(saves).toHaveLength(2);
    expect(new Set(saves.map((s) => s.id)).size).toBe(2);
    expect(saves[0]?.disabledWhen).toBeUndefined();
    // Une expression non résolue est gardée telle quelle (aucune réécriture inventée).
    expect(saves[1]?.disabledWhen?.expression).toBe('computeRisk(state.items) > limit');
    // Le même nom dans un autre composant : un autre identifiant.
    const other = parseTemplate('OtherComponent', '<button (click)="save()">Save</button>', 'o.html', 0);
    expect(other[0]?.id).not.toBe(saves[0]?.id);
  });

  it('les membres lus par une expression : racines et chemins, sans mots-clés ni chaînes', () => {
    expect(membersOf('state.canValidate && !form.invalid')).toEqual([
      { root: 'state', path: ['canValidate'] },
      { root: 'form', path: ['invalid'] },
    ]);
    expect(membersOf("user?.role === 'ADMIN' || isOwner()").map((m) => m.root)).toEqual(['user', 'isOwner']);
  });

  it('la négation simple est retirée à l’affichage ; une expression composée reste entière', () => {
    expect(shownExpression({ expression: '!state.canValidate', whenTrue: false })).toBe('state.canValidate');
    expect(shownExpression({ expression: 'a && b', whenTrue: false })).toBe('!(a && b)');
    expect(shownExpression({ expression: '!(x.ok$ | async)', whenTrue: false })).toBe('x.ok$ | async');
    expect(shownExpression({ expression: '!(a) && (b)', whenTrue: false })).toBe('!(!(a) && (b))');
    expect(shownExpression({ expression: 'x', whenTrue: true })).toBe('x');
  });
});

describe('Java : décisions booléennes et champs calculés', () => {
  const facts = analyzeJava('backend', 'BACKEND', [
    file(
      'src/main/java/x/EligibilityService.java',
      `package x;
public class EligibilityService {
  public boolean canValidate(Request request) {
    for (Document document : request.getDocuments()) {
      if (!document.isVerified()) return false;
    }
    return request.getAmount() != null && request.getAmount() > 0;
  }
  public boolean isActive() { return active; }
  private boolean active;
}`,
    ),
    file(
      'src/main/java/x/StateService.java',
      `package x;
public class StateService {
  private final EligibilityService eligibility;
  public StateView state(Request request) {
    StateView view = new StateView();
    view.setCanValidate(eligibility.canValidate(request));
    view.setName(request.getName());
    return view;
  }
}`,
    ),
    file(
      'src/main/java/x/StateView.java',
      'package x;\npublic class StateView { private boolean canValidate; private String name; }',
    ),
  ]);

  it('une méthode booléenne non triviale est une décision : boucle, prédicats, données lues, paramètres', () => {
    const decision = facts.decisions?.find((d) => d.name === 'canValidate');
    expect(decision).toMatchObject({ owner: 'EligibilityService', loops: 1, params: ['Request'] });
    expect(decision?.reads).toEqual(
      expect.arrayContaining(['Request.documents', 'Document.verified', 'Request.amount']),
    );
    expect(decision?.predicates.length).toBeGreaterThan(0);
    // Un simple accesseur n'en est pas une.
    expect(facts.decisions?.some((d) => d.name === 'isActive')).toBe(false);
  });

  it('un setter alimenté par un appel de méthode est un champ calculé (un getter sans argument ne l’est pas)', () => {
    expect(facts.computed).toEqual([
      expect.objectContaining({
        toClass: 'StateView',
        toField: 'canValidate',
        callee: 'EligibilityService.canValidate',
        method: 'StateService.state',
      }),
    ]);
  });
});

describe('scan réel : structure, conditions Backend, actions', () => {
  let index: MapIndex;
  let structure: MapStructure;
  const flat: StructureItem[] = [];
  const item = (name: string, kind?: string): StructureItem => {
    const found = flat.find((i) => i.name === name && (!kind || i.kind === kind));
    if (!found) throw new Error(`élément absent : ${name}`);
    return found;
  };

  beforeAll(async () => {
    const { model } = await runScan({ config, allowedRoots: [FIXTURE], incremental: false });
    index = buildIndex(model);
    const feature = model.features.find((f) => f.name === 'Request create');
    structure = structureOf(index, feature?.id) as MapStructure;
    const walk = (items: StructureItem[]): void => {
      for (const i of items) {
        flat.push(i);
        walk(i.children);
      }
    };
    walk(structure.roots);
  });

  it('l’arbre : écran → composant → conteneurs (dans l’ordre du gabarit) → champs et boutons ; comptes', () => {
    expect(structure.roots.map((r) => `${r.kind} ${r.name}`)).toEqual(['ROUTE /requests/create']);
    const component = structure.roots[0]?.children[0];
    expect(component?.name).toBe('RequestCreateComponent');
    expect(component?.children.map((c) => c.name)).toEqual([
      'General information',
      'Company',
      'Save',
      'Validation',
      'Attachments',
    ]);
    expect(item('Validation').children.map((c) => `${c.kind} ${c.name}`)).toEqual([
      'BUTTON Validate',
      'BUTTON Refuse',
    ]);
    expect(structure.kpis).toEqual({
      pages: 1,
      containers: 4,
      fields: 9,
      buttons: 3,
      internalApis: 8,
      externalApis: 1,
      conditions: 4,
    });
  });

  it('conteneur piloté par un booléen Backend : chaîne jusqu’à la méthode et la donnée lue', () => {
    const sheet = elementSheet(index, cov, item('Validation').id);
    const condition = sheet?.conditions[0];
    expect(condition).toMatchObject({
      aspect: 'VISIBLE',
      expression: 'state.showValidationSection',
      whenTrue: true,
    });
    expect(condition?.decision?.method.name).toBe('ValidationEligibilityService.isEligibleForValidation');
    expect(condition?.decision?.reads).toContain('Request.status');
    // La méthode qui écrit `state` (ngOnInit, depuis la réponse de loadState) fait partie de la provenance.
    expect(condition?.chain.nodes.map((n) => n.kind)).toEqual([
      'CONDITION',
      'FIELD',
      'METHOD',
      'METHOD',
      'FIELD',
      'FIELD',
      'METHOD',
      'ENTITY',
    ]);
    expect(condition?.chain.edges.map((e) => e.reason)).toContain(
      'state est écrit par ngOnInit() (affectation)',
    );
    // Les liens de nom (même propriété JSON entre BFF et Backend) sont probables, jamais affirmés.
    expect(condition?.status).toBe('PROBABLE');
    expect(
      condition?.chain.edges.some((e) => e.kind === 'CONTROLLED_BY' && e.confidence === 'PROBABLE'),
    ).toBe(true);
  });

  it('champ conditionnel : la condition du conteneur est héritée, avec son origine', () => {
    const name = item('Company name', 'FIELD');
    const sheet = elementSheet(index, cov, name.id);
    expect(sheet?.conditions).toHaveLength(1);
    expect(sheet?.conditions[0]).toMatchObject({
      inherited: 'Company',
      expression: 'state.showCompanySection',
    });
    expect(sheet?.conditions[0]?.decision?.method.name).toBe('ValidationEligibilityService.needsCompany');
  });

  it('bouton désactivé par une décision avec boucle ; sa visibilité héritée du conteneur', () => {
    const sheet = elementSheet(index, cov, item('Validate', 'BUTTON').id);
    const enabled = sheet?.conditions.find((c) => c.aspect === 'ENABLED');
    expect(enabled).toMatchObject({ expression: '!state.canValidate', whenTrue: false });
    expect(shownExpression(enabled ?? { expression: '', whenTrue: true })).toBe('state.canValidate');
    expect(enabled?.decision).toMatchObject({ loops: 1 });
    expect(enabled?.decision?.method.name).toBe('ValidationEligibilityService.canValidate');
    expect(sheet?.conditions.find((c) => c.aspect === 'VISIBLE')?.inherited).toBe('Validation');
  });

  it('action : gestionnaire → service → endpoint BFF → endpoint Backend → API externe, table écrite', () => {
    const sheet = elementSheet(index, cov, item('Validate', 'BUTTON').id);
    const action = sheet?.actions[0];
    expect(action?.handler).toBe('validateRequest');
    expect(action?.triggers.map((t) => t.name)).toEqual(['RequestService.validate']);
    expect(action?.endpoints.map((e) => `${e.layer} ${e.name}`)).toEqual([
      'BFF POST /api/requests/validate',
      'BACKEND POST /requests/validate',
    ]);
    expect(action?.outbound.map((o) => `${o.method ?? ''} ${o.path ?? ''}`)).toEqual([
      'POST /partner/verify',
    ]);
    expect(action?.entities).toEqual([{ name: 'REQUEST', access: 'WRITE' }]);
    // Le bouton Save (homonyme d'aucun autre ici) n'emprunte pas la chaîne de validation.
    const save = elementSheet(index, cov, item('Save', 'BUTTON').id);
    expect(save?.actions[0]?.endpoints.map((e) => e.name)).toEqual(['POST /api/requests', 'POST /requests']);
    expect(save?.outbound).toEqual([]);
  });

  it('non déterminé : une valeur locale du composant n’a aucune décision Backend, la cause est dite', () => {
    const sheet = elementSheet(index, cov, item('Attachments').id);
    expect(sheet?.conditions[0]).toMatchObject({ status: 'UNKNOWN', expression: '!hasPermission' });
    expect(sheet?.conditions[0]?.decision).toBeUndefined();
    expect(sheet?.conditions[0]?.undetermined).toMatch(/hasPermission/);
    expect(sheet?.actions).toEqual([]);
  });

  it('listes du projet : conditions (avec recherche) et actions, paginées', () => {
    const all = conditionRows(index, {});
    expect(all.total).toBe(4);
    expect(all.items.map((r) => `${r.element.name}:${r.decision ?? '—'}`)).toEqual([
      'Attachments:—',
      'Company:ValidationEligibilityService.needsCompany',
      'Validate:ValidationEligibilityService.canValidate',
      'Validation:ValidationEligibilityService.isEligibleForValidation',
    ]);
    expect(conditionRows(index, { q: 'canvalidate' }).items.map((r) => r.element.name)).toEqual(['Validate']);
    const actions = actionRows(index, { size: 2 });
    expect(actions.total).toBe(3);
    expect(actions.items).toHaveLength(2);
    const validate = actionRows(index, { q: 'validate' }).items.find((r) => r.name === 'Validate');
    expect(validate?.externals).toEqual(['POST /partner/verify (api.partner.example)']);
  });

  it('un identifiant inconnu ou d’une autre sorte ne donne pas de fiche', () => {
    expect(elementSheet(index, cov, 'BUTTON:front:nope')).toBeUndefined();
    expect(elementSheet(index, cov, structure.roots[0]?.id ?? '')).toBeUndefined();
  });
});

describe('gabarits en ligne entre guillemets', () => {
  const file = (text: string) => ({ path: 'src/app/vide.component.ts', text, hash: '', bytes: text.length });
  it('un gabarit vide ou entre guillemets est lu, sans avertissement « introuvable »', () => {
    for (const quoted of ["''", '""', '\'<section><button (click)="go()">Aller</button></section>\'']) {
      const facts = analyzeTemplates(
        [
          file(
            `@Component({ selector: 'app-vide', template: ${quoted} })\nexport class VideComponent { go() {} }\n`,
          ),
        ],
        new Set(),
      );
      expect(facts.warnings).toEqual([]);
    }
    const lu = analyzeTemplates(
      [
        file(
          `@Component({ selector: 'app-vide', template: '<button (click)="go()">Aller</button>' })\nexport class VideComponent { go() {} }\n`,
        ),
      ],
      new Set(),
    );
    expect(lu.elements.some((e) => e.kind === 'BUTTON')).toBe(true);
  });
  it('un templateUrl absent reste signalé', () => {
    const facts = analyzeTemplates(
      [file(`@Component({ selector: 'app-x', templateUrl: './absent.html' })\nexport class XComponent {}\n`)],
      new Set(),
    );
    expect(facts.warnings).toEqual(['gabarit de XComponent introuvable : structure non analysée']);
  });
});
