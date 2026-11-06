import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CartographyModel, MapCorrelation } from '../../src/sdk/core/cartography.js';
import { runScan } from '../../src/cartography/scan.js';

/**
 * Corrélation Frontend → Backend des formes d'URL courantes : base d'environnement, context-path, base de
 * classe, paramètres de chemin et de requête, enveloppe générique, constante importée d'un autre fichier ;
 * et deux négatifs (méthode absente, ressource absente servie par une variable de chemin).
 */
const FILES: Record<string, string> = {
  'back/src/main/java/com/ex/web/OrderController.java':
    'package com.ex.web;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  @GetMapping public String list(@RequestParam(required = false) String q) { return ""; }\n  @GetMapping("/{id}") public String one(@PathVariable String id) { return id; }\n  @GetMapping("/{id}/items") public String items(@PathVariable("id") String id) { return id; }\n  @GetMapping("/stats") public String stats() { return ""; }\n  @PostMapping public String create(@RequestBody String body) { return body; }\n  @DeleteMapping("/{orderId}") public void remove(@PathVariable String orderId) { }\n}\n',
  'back/src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /svc\n',
  'front/package.json':
    '{ "name": "front", "dependencies": { "@angular/core": "17.0.0", "@angular/common": "17.0.0", "rxjs": "7.8.0" } }\n',
  'front/src/app/core/api-urls.ts': "export const ORDERS_URL = '/svc/api/orders';\n",
  'front/src/app/core/api.service.ts':
    "import { Injectable } from '@angular/core';\nimport { HttpClient, HttpParams } from '@angular/common/http';\nimport { Observable } from 'rxjs';\nimport { environment } from '../../environments/environment';\n@Injectable({ providedIn: 'root' })\nexport class ApiService {\n  constructor(private http: HttpClient) {}\n  get<T>(path: string, params?: HttpParams): Observable<T> { return this.http.get<T>(`${environment.apiUrl}${path}`, { params }); }\n  post<T>(path: string, body: unknown): Observable<T> { return this.http.post<T>(environment.apiUrl + path, body); }\n}\n",
  'front/src/app/orders/order.service.ts':
    "import { Injectable } from '@angular/core';\nimport { HttpClient, HttpParams } from '@angular/common/http';\nimport { environment } from '../../environments/environment';\nimport { ApiService } from '../core/api.service';\nimport { ORDERS_URL } from '../core/api-urls';\n@Injectable({ providedIn: 'root' })\nexport class OrderService {\n  private readonly base = `${environment.apiUrl}/orders`;\n  constructor(private http: HttpClient, private api: ApiService) {}\n  // 1. base de classe + param\u00e8tre de chemin\n  one(id: string) { return this.http.get(`${this.base}/${id}`); }\n  // 2. sous-ressource\n  items(id: string) { return this.http.get(`${this.base}/${id}/items`); }\n  // 3. param\u00e8tres de requ\u00eate\n  search(q: string) { const params = new HttpParams().set('q', q); return this.http.get(this.base, { params }); }\n  // 4. via un wrapper\n  list() { return this.api.get('/orders'); }\n  // 5. wrapper en POST, concat\u00e9nation\n  create(body: unknown) { return this.api.post('/orders', body); }\n  // 6. constante import\u00e9e\n  remove(id: string) { return this.http.delete(ORDERS_URL + '/' + id); }\n  // 8. m\u00e9thode PUT inexistante c\u00f4t\u00e9 serveur (n\u00e9gatif)\n  replace(id: string, body: unknown) { return this.http.put(`${this.base}/${id}`, body); }\n  // 9. ressource inexistante (n\u00e9gatif)\n  missing() { return this.http.get(`${this.base}/archive`); }\n}\n",
  'front/src/app/orders/orders.component.ts':
    "import { Component } from '@angular/core';\nimport { OrderService } from './order.service';\n@Component({ selector: 'app-orders', template: `<button (click)=\"load()\">Load</button><button (click)=\"add()\">Add</button>` })\nexport class OrdersComponent {\n  constructor(private orders: OrderService) {}\n  load() { this.orders.list().subscribe(); this.orders.one('1').subscribe(); this.orders.items('1').subscribe(); this.orders.search('x').subscribe(); this.orders.missing().subscribe(); }\n  add() { this.orders.create({}).subscribe(); this.orders.remove('1').subscribe(); this.orders.replace('1', {}).subscribe(); }\n}\n",
  'front/src/environments/environment.ts':
    "export const environment = { production: false, apiUrl: '/svc/api' };\n",
};

let root: string;
let model: CartographyModel;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'qa-http-correlation-'));
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  ({ model } = await runScan({
    config: {
      schema: 1,
      sources: [
        {
          id: 'front',
          name: 'Front',
          layer: 'FRONTEND',
          path: path.join(root, 'front'),
          include: [],
          enabled: true,
        },
        {
          id: 'back',
          name: 'Back',
          layer: 'BACKEND',
          path: path.join(root, 'back'),
          include: [],
          enabled: true,
        },
      ],
    },
    allowedRoots: [root],
    incremental: false,
  }));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const of = (method: string, p: string): MapCorrelation[] =>
  (model.correlations ?? []).filter((c) => c.method === method && c.path === p);
/** `API:source:GET /chemin` → `GET /chemin`. */
const target = (c: MapCorrelation | undefined): string => c?.target?.replace(/^\w+:[^:]+:/, '') ?? '';

describe('Frontend → Backend HTTP correlation', () => {
  it('environment base, context-path, class base, path and query parameters, wrapper: confirmed', () => {
    const expected: [string, string, string][] = [
      ['GET', '/svc/api/orders/{param}', 'GET /api/orders/{id}'],
      ['GET', '/svc/api/orders/{param}/items', 'GET /api/orders/{id}/items'],
      ['GET', '/svc/api/orders', 'GET /api/orders'],
      ['POST', '/svc/api/orders', 'POST /api/orders'],
    ];
    for (const [method, p, to] of expected) {
      const found = of(method, p);
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((c) => c.status === 'CONFIRMED' && target(c) === to)).toBe(true);
    }
  });

  it('a constant imported from another file forms the URL, with its provenance', () => {
    const [remove] = of('DELETE', '/svc/api/orders/{param}');
    expect(remove?.status).toBe('CONFIRMED');
    expect(target(remove)).toBe('DELETE /api/orders/{orderId}');
    expect((model.correlations ?? []).some((c) => c.path.includes('{base}'))).toBe(false);
  });

  it('never confirms a method the server does not serve', () => {
    const [replace] = of('PUT', '/svc/api/orders/{param}');
    expect(replace?.status).toBe('UNDEMONSTRATED');
    expect(replace?.causes.map((c) => c.code)).toContain('METHOD_MISMATCH');
    expect(replace?.target).toBeUndefined();
  });
});
