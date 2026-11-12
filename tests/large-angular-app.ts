import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * UNE APPLICATION ANGULAR SYNTHÉTIQUE DE GRANDE TAILLE, pour éprouver la cartographie : des centaines de
 * modules fonctionnels, chacun avec son API HTTP, son store RxJS, son composant, son gabarit, ses
 * fonctions utilitaires et un fichier de test. Cinq styles RxJS sont mélangés (un par module, en
 * rotation), comme dans une application réelle écrite par plusieurs équipes :
 *
 * - A : dispatch(action) par switch, Subject d'actions + filter + switchMap ;
 * - B : méthodes et Subjects, debounceTime / distinctUntilChanged / exhaustMap, combineLatest avec un
 *   état partagé entre modules (SessionStore), catchError, takeUntil ;
 * - C : créateurs d'actions, un seul Subject, plusieurs pipes filtrés par type (filter en ligne) ;
 * - D : façade + store, souscriptions installées dans le constructeur, withLatestFrom + concatMap, pipe
 *   async dans le gabarit ; un enregistrement recharge la liste (submit atteint donc list, à raison) ;
 * - E : comme C, mais la garde par type passe par une fonction utilitaire générique (ofType).
 *
 * Les composants des styles A, B et C s'appellent tous `ListComponent` (un par dossier) et les routes les
 * importent sous un alias ; toutes les 50 fonctionnalités, une route importe un composant d'un fichier
 * absent. La vérité attendue de chaque parcours est rendue avec l'application.
 */
export type RxStyle = 'A' | 'B' | 'C' | 'D' | 'E';

export interface FeatureTruth {
  index: number;
  style: RxStyle;
  /** Le préfixe des classes (`Invoice12`). */
  prefix: string;
  folder: string;
  route: string;
  /** Le nom de la classe du composant et son dossier. */
  component: string;
  componentFile: string;
  /** Les méthodes HTTP de son API que submit et reload doivent atteindre, ou jamais atteindre. */
  submitReaches: string[];
  submitNever: string[];
  reloadReaches: string[];
  reloadNever: string[];
}

export interface LargeAppTruth {
  features: FeatureTruth[];
  /** Les routes dont le composant est importé d'un fichier absent (liens non résolus attendus). */
  missingRoutes: string[];
  files: number;
  lines: number;
}

const ENTITIES = [
  'Invoice',
  'Ticket',
  'Shipment',
  'Product',
  'Contract',
  'Report',
  'Booking',
  'Asset',
  'Payment',
  'Vendor',
  'Policy',
  'Claim',
];
const STYLES: readonly RxStyle[] = ['A', 'B', 'C', 'D', 'E'];

export async function generateLargeAngularApp(
  root: string,
  options: { features: number; helpersPerFeature?: number; missingEvery?: number },
): Promise<LargeAppTruth> {
  const helpers = options.helpersPerFeature ?? 40;
  const missingEvery = options.missingEvery ?? 50;
  const app = path.join(root, 'src', 'app');
  let files = 0;
  let lines = 0;
  const write = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    files += 1;
    lines += text.split('\n').length;
  };
  await write(
    path.join(root, 'package.json'),
    JSON.stringify(
      { name: 'large-app', private: true, dependencies: { '@angular/core': '^17.0.0', rxjs: '^7.8.0' } },
      null,
      2,
    ),
  );
  await write(
    path.join(app, 'core', 'session.store.ts'),
    `import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** L'état partagé entre tous les modules : l'utilisateur courant. */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly user = new BehaviorSubject<{ name: string } | null>(null);
  readonly user$ = this.user.asObservable();

  touch(name: string): void {
    this.user.next({ name });
  }
}
`,
  );
  await write(
    path.join(app, 'core', 'rx-helpers.ts'),
    `import { filter } from 'rxjs';

/** Garde les actions d'un type (style E). */
export function ofType<A extends { type: string }>(type: A['type']) {
  return filter((action: A) => action.type === type);
}
`,
  );

  const features: FeatureTruth[] = [];
  const missingRoutes: string[] = [];
  const imports: string[] = [];
  const routes: string[] = [];
  for (let i = 1; i <= options.features; i += 1) {
    const style = STYLES[(i - 1) % STYLES.length] ?? 'A';
    const entity = ENTITIES[(i - 1) % ENTITIES.length] ?? 'Item';
    const prefix = `${entity}${String(i)}`;
    const folder = `${entity.toLowerCase()}-${String(i)}`;
    const base = path.join(app, folder);
    const fileBase = folder;
    const url = `/api/${folder}/items`;
    const homonym = style === 'A' || style === 'B' || style === 'C';
    const component = homonym ? 'ListComponent' : `${prefix}PageComponent`;
    const componentRel = homonym ? `${folder}/list/list.component` : `${folder}/${fileBase}.page`;
    const componentDir = path.join(app, path.dirname(componentRel));
    const componentFile = `${path.basename(componentRel)}.ts`;
    const toFolder = homonym ? '..' : '.';

    await write(
      path.join(base, `${fileBase}.models.ts`),
      `export interface ${prefix}Item {
  id: string;
  title: string;
  amount: number;
}

export type ${prefix}Action =
  | { type: 'LOAD' }
  | { type: 'SAVE'; title: string }
  | { type: 'VALIDATE'; title: string }
  | { type: 'RESET' };

export interface ${prefix}State {
  status: 'IDLE' | 'LOADED' | 'SAVED' | 'INVALID';
  items: ${prefix}Item[];
}

export const load${prefix} = (): ${prefix}Action => ({ type: 'LOAD' });
export const validate${prefix} = (title: string): ${prefix}Action => ({ type: 'VALIDATE', title });
`,
    );
    await write(
      path.join(base, `${fileBase}.api.ts`),
      `import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ${prefix}Item } from './${fileBase}.models';

@Injectable({ providedIn: 'root' })
export class ${prefix}Api {
  constructor(private http: HttpClient) {}

  list(): Observable<${prefix}Item[]> {
    return this.http.get<${prefix}Item[]>('${url}');
  }

  create(title: string): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('${url}', { title });
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(\`${url}/\${id}\`);
  }
}
`,
    );

    let store: string;
    let componentBody: string;
    let template: string;
    let componentImports: string;
    let injected: string;
    if (style === 'A') {
      store = `import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, filter, switchMap } from 'rxjs';
import { ${prefix}Api } from './${fileBase}.api';
import { ${prefix}Action, ${prefix}State } from './${fileBase}.models';

@Injectable({ providedIn: 'root' })
export class ${prefix}Store {
  private readonly state = new BehaviorSubject<${prefix}State>({ status: 'IDLE', items: [] });
  readonly state$ = this.state.asObservable();
  private readonly actions = new Subject<${prefix}Action>();
  readonly saved$ = this.actions.pipe(
    filter((a) => a.type === 'SAVE'),
    switchMap((a) => this.api.create(a.type === 'SAVE' ? a.title : '')),
  );

  constructor(private api: ${prefix}Api) {}

  dispatch(action: ${prefix}Action): void {
    switch (action.type) {
      case 'LOAD':
        this.load();
        break;
      case 'SAVE':
        this.actions.next(action);
        break;
      case 'VALIDATE':
        this.validate(action.title);
        break;
      case 'RESET':
        this.state.next({ status: 'IDLE', items: [] });
        break;
    }
  }

  private load(): void {
    this.api.list().subscribe((items) => this.state.next({ status: 'LOADED', items }));
  }

  private validate(title: string): void {
    if (title.length > 0) this.dispatch({ type: 'SAVE', title });
    else this.state.next({ status: 'INVALID', items: [] });
  }
}
`;
      componentImports = `import { ${prefix}Store } from '${toFolder}/${fileBase}.store';`;
      injected = `private store: ${prefix}Store`;
      componentBody = `  ngOnInit(): void {
    this.store.state$.subscribe((state) => this.onState(state.status));
    this.store.saved$.subscribe((result) => this.onSaved(result.id));
    this.store.dispatch({ type: 'LOAD' });
  }

  submit(title: string): void {
    const s = this.store;
    s.dispatch({ type: 'VALIDATE', title });
  }

  reload(): void {
    this.store.dispatch({ type: 'LOAD' });
  }`;
      template = `<p *ngIf="status === 'INVALID'">Title required</p>`;
    } else if (style === 'B') {
      store = `import { Injectable } from '@angular/core';
import {
  BehaviorSubject,
  Subject,
  catchError,
  combineLatest,
  debounceTime,
  distinctUntilChanged,
  exhaustMap,
  map,
  of,
  tap,
} from 'rxjs';
import { SessionStore } from '../core/session.store';
import { ${prefix}Api } from './${fileBase}.api';
import { ${prefix}Item } from './${fileBase}.models';

@Injectable({ providedIn: 'root' })
export class ${prefix}Store {
  private readonly items = new BehaviorSubject<${prefix}Item[]>([]);
  readonly items$ = this.items.asObservable();
  private readonly save = new Subject<string>();
  readonly saved$ = this.save.pipe(
    debounceTime(50),
    distinctUntilChanged(),
    exhaustMap((title) => this.api.create(title)),
    tap(() => this.session.touch('${folder}')),
  );
  readonly view$ = combineLatest([this.items$, this.session.user$]).pipe(
    map(([items, user]) => ({ items, user })),
  );

  constructor(
    private api: ${prefix}Api,
    private session: SessionStore,
  ) {}

  load(): void {
    this.api
      .list()
      .pipe(catchError(() => of([] as ${prefix}Item[])))
      .subscribe((items) => this.items.next(items));
  }

  validate(title: string): void {
    if (title.trim().length > 0) this.save.next(title);
  }
}
`;
      componentImports = `import { Subject, takeUntil } from 'rxjs';
import { SessionStore } from '../../core/session.store';
import { ${prefix}Store } from '${toFolder}/${fileBase}.store';`;
      injected = `private store: ${prefix}Store, private session: SessionStore`;
      componentBody = `  private readonly destroy$ = new Subject<void>();
  count = 0;
  user?: string;

  ngOnInit(): void {
    this.store.view$.pipe(takeUntil(this.destroy$)).subscribe((v) => this.onView(v.items.length));
    this.store.saved$.pipe(takeUntil(this.destroy$)).subscribe((r) => this.onSaved(r.id));
    this.session.user$.pipe(takeUntil(this.destroy$)).subscribe((u) => this.onUser(u?.name));
    this.store.load();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
  }

  submit(title: string): void {
    this.store.validate(title);
  }

  reload(): void {
    this.store.load();
  }

  private onView(count: number): void {
    this.count = count;
  }

  private onUser(name: string | undefined): void {
    this.user = name;
  }`;
      template = `<p *ngIf="count === 0">No item</p>`;
    } else if (style === 'C' || style === 'E') {
      const saveFilter =
        style === 'C' ? `filter((a) => a.type === 'SAVE')` : `ofType<${prefix}Action>('SAVE')`;
      const loadFilter =
        style === 'C' ? `filter((a) => a.type === 'LOAD')` : `ofType<${prefix}Action>('LOAD')`;
      store = `import { Injectable } from '@angular/core';
import { Subject, filter, mergeMap, switchMap } from 'rxjs';
${style === 'E' ? `import { ofType } from '../core/rx-helpers';\n` : ''}import { ${prefix}Api } from './${fileBase}.api';
import { ${prefix}Action } from './${fileBase}.models';

@Injectable({ providedIn: 'root' })
export class ${prefix}Store {
  private readonly actions = new Subject<${prefix}Action>();
  readonly saved$ = this.actions.pipe(
    ${saveFilter},
    mergeMap((a) => this.api.create(a.type === 'SAVE' ? a.title : '')),
  );
  readonly loaded$ = this.actions.pipe(
    ${loadFilter},
    switchMap(() => this.api.list()),
  );

  constructor(private api: ${prefix}Api) {}

  dispatch(action: ${prefix}Action): void {
    this.actions.next(action);
    if (action.type === 'VALIDATE' && action.title.length > 0)
      this.actions.next({ type: 'SAVE', title: action.title });
  }
}
`;
      componentImports = `import { ${prefix}Store } from '${toFolder}/${fileBase}.store';
import { load${prefix}, validate${prefix} } from '${toFolder}/${fileBase}.models';`;
      injected = `private store: ${prefix}Store`;
      componentBody = `  count = 0;

  ngOnInit(): void {
    this.store.loaded$.subscribe((items) => this.onLoaded(items.length));
    this.store.saved$.subscribe((result) => this.onSaved(result.id));
    this.store.dispatch(load${prefix}());
  }

  submit(title: string): void {
    this.store.dispatch(validate${prefix}(title));
  }

  reload(): void {
    this.store.dispatch(load${prefix}());
  }

  private onLoaded(count: number): void {
    this.count = count;
  }`;
      template = `<p *ngIf="count === 0">No item</p>`;
    } else {
      store = `import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject, concatMap, switchMap, withLatestFrom } from 'rxjs';
import { ${prefix}Api } from './${fileBase}.api';
import { ${prefix}Item } from './${fileBase}.models';

@Injectable({ providedIn: 'root' })
export class ${prefix}Store {
  private readonly items = new BehaviorSubject<${prefix}Item[]>([]);
  readonly items$ = this.items.asObservable();
  private readonly refreshes = new Subject<void>();
  private readonly saves = new Subject<string>();

  constructor(private api: ${prefix}Api) {
    this.refreshes.pipe(switchMap(() => this.api.list())).subscribe((items) => this.items.next(items));
    this.saves
      .pipe(
        withLatestFrom(this.items$),
        concatMap(([title]) => this.api.create(title)),
      )
      .subscribe(() => this.refresh());
  }

  refresh(): void {
    this.refreshes.next();
  }

  save(title: string): void {
    this.saves.next(title);
  }
}
`;
      await write(
        path.join(base, `${fileBase}.facade.ts`),
        `import { Injectable } from '@angular/core';
import { ${prefix}Store } from './${fileBase}.store';

@Injectable({ providedIn: 'root' })
export class ${prefix}Facade {
  readonly items$ = this.store.items$;

  constructor(private store: ${prefix}Store) {}

  save(title: string): void {
    this.store.save(title);
  }

  refresh(): void {
    this.store.refresh();
  }
}
`,
      );
      componentImports = `import { ${prefix}Facade } from './${fileBase}.facade';`;
      injected = `readonly facade: ${prefix}Facade`;
      componentBody = `  ngOnInit(): void {
    this.facade.refresh();
  }

  submit(title: string): void {
    this.facade.save(title);
  }

  reload(): void {
    this.facade.refresh();
  }`;
      template = `<ul><li *ngFor="let item of facade.items$ | async">{{ item.title }}</li></ul>`;
    }
    await write(path.join(base, `${fileBase}.store.ts`), store);
    const htmlFile = homonym ? 'list.component.html' : `${fileBase}.page.html`;
    await write(
      path.join(componentDir, componentFile),
      `import { Component, OnInit } from '@angular/core';
${componentImports}

@Component({
  selector: 'app-${folder}',
  templateUrl: './${htmlFile}',
})
export class ${component} implements OnInit {
  status = 'IDLE';
  savedId?: string;

  constructor(${injected}) {}

${componentBody}

  private onState(status: string): void {
    this.status = status;
  }

  private onSaved(id: string): void {
    this.savedId = id;
  }
}
`,
    );
    await write(
      path.join(componentDir, htmlFile),
      `<button type="button" (click)="submit('New')">Save</button>
<button type="button" (click)="reload()">Reload</button>
${template}
<p *ngIf="savedId">Saved</p>
`,
    );
    await write(
      path.join(componentDir, componentFile.replace(/\.ts$/, '.spec.ts')),
      `import { ${component} } from './${componentFile.replace(/\.ts$/, '')}';

describe('${component} of ${folder}', () => {
  it('submits', () => {
    const component = new ${component}({} as never${style === 'B' ? ', {} as never' : ''});
    component.submit('x');
    component.reload();
  });
});
`,
    );
    // Le code ordinaire d'un module : des fonctions de mise en forme qui s'appellent entre elles.
    const fns: string[] = [];
    for (let h = 0; h < helpers; h += 1)
      fns.push(`export function format${prefix}Value${String(h)}(value: number, digits = 2): string {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  if (Number.isNaN(rounded)) return '';
  ${h > 0 ? `return format${prefix}Value${String(h - 1)}(rounded, digits) + '${String(h)}';` : 'return rounded.toFixed(digits);'}
}
`);
    await write(path.join(base, `${fileBase}.mappers.ts`), fns.join('\n'));

    const alias = homonym ? `${prefix}List` : component;
    imports.push(
      homonym
        ? `import { ListComponent as ${alias} } from './${componentRel}';`
        : `import { ${component} } from './${componentRel}';`,
    );
    routes.push(`  { path: '${folder}', component: ${alias} },`);
    if (i % missingEvery === 0) {
      imports.push(`import { Legacy${String(i)}Component } from './legacy-${String(i)}/legacy.component';`);
      routes.push(`  { path: 'legacy-${String(i)}', component: Legacy${String(i)}Component },`);
      missingRoutes.push(`/legacy-${String(i)}`);
    }
    const api = (m: string): string => `${prefix}Api#${m}`;
    features.push({
      index: i,
      style,
      prefix,
      folder,
      route: `/${folder}`,
      component,
      componentFile: path.posix.join('src/app', `${componentRel}.ts`),
      submitReaches: style === 'D' ? [api('create'), api('list')] : [api('create')],
      submitNever: style === 'D' ? [api('remove')] : [api('list'), api('remove')],
      reloadReaches: [api('list')],
      reloadNever: [api('create'), api('remove')],
    });
  }
  await write(
    path.join(app, 'app.routes.ts'),
    `import { Routes } from '@angular/router';
${imports.join('\n')}

export const routes: Routes = [
${routes.join('\n')}
];
`,
  );
  return { features, missingRoutes, files, lines };
}
