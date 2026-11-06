/**
 * Un projet synthétique écrit à la demande (rien n’est commité sauf ce générateur) : un store de 300 propriétés
 * (BehaviorSubject et leur observable), un sujet sans consommateur, un appel HTTP, et côté backend deux
 * services qui s’appellent l’un l’autre avant d’écrire une table. Il sert aux tests du moteur
 * d’investigation : exploration ciblée sur un grand store, cycle avec sortie, rupture sans consommateur.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
export async function writeLargeStoreProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'qa-inv-synth-'));
  const w = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  };
  const N = 300;
  const props = Array.from(
    { length: N },
    (_, i) =>
      `  private readonly p${i} = new BehaviorSubject<number>(${i});\n  readonly p${i}$ = this.p${i}.asObservable();`,
  ).join('\n');
  const setters = Array.from(
    { length: N },
    (_, i) => `  setP${i}(v: number): void {\n    this.p${i}.next(v);\n  }`,
  ).join('\n');
  await w(
    'front/package.json',
    JSON.stringify({ name: 'synth-front', dependencies: { '@angular/core': '17.0.0', rxjs: '7.8.0' } }),
  );
  await w(
    'front/src/app/geant.store.ts',
    `import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { GeantApi } from './geant.api';

@Injectable({ providedIn: 'root' })
export class GeantStore {
${props}
  private readonly orphelin = new BehaviorSubject<number>(0);

  constructor(private api: GeantApi) {}

${setters}
  enregistrer(v: number): void {
    this.p7.next(v);
    this.api.sauver(v).subscribe((r) => this.p8.next(r));
  }

  oublier(v: number): void {
    this.orphelin.next(v);
  }
}
`,
  );
  await w(
    'front/src/app/geant.api.ts',
    `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class GeantApi {
  constructor(private http: HttpClient) {}

  sauver(v: number): Observable<number> {
    return this.http.post<number>('/api/geant', { v });
  }
}
`,
  );
  await w(
    'front/src/app/geant-page.component.ts',
    `import { Component } from '@angular/core';
import { GeantStore } from './geant.store';

@Component({ selector: 'app-geant', templateUrl: './geant-page.component.html' })
export class GeantPageComponent {
  readonly p8$ = this.store.p8$;
  readonly p9$ = this.store.p9$;

  constructor(private store: GeantStore) {}

  enregistrer(): void {
    this.store.enregistrer(1);
  }

  oublier(): void {
    this.store.oublier(2);
  }
}
`,
  );
  await w(
    'front/src/app/geant-page.component.html',
    `<section>
  <p>{{ p8$ | async }} {{ p9$ | async }}</p>
  <button (click)="enregistrer()">Enregistrer</button>
  <button (click)="oublier()">Oublier</button>
</section>
`,
  );
  await w(
    'front/src/app/app.routes.ts',
    `import { Routes } from '@angular/router';
import { GeantPageComponent } from './geant-page.component';
export const routes: Routes = [{ path: 'geant', component: GeantPageComponent }];
`,
  );
  const j = (rel: string, text: string) => w(`backend/src/main/java/com/ex/geant/${rel}`, text);
  await w(
    'backend/pom.xml',
    `<project><modelVersion>4.0.0</modelVersion><groupId>com.ex</groupId><artifactId>geant</artifactId><version>1.0.0</version></project>`,
  );
  await j(
    'GeantController.java',
    `package com.ex.geant;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class GeantController {
  private final PremierService premier;

  public GeantController(PremierService premier) {
    this.premier = premier;
  }

  @PostMapping("/geant")
  public int sauver(@RequestBody Object body) {
    return premier.traiter(1);
  }
}
`,
  );
  await j(
    'PremierService.java',
    `package com.ex.geant;

import org.springframework.stereotype.Service;

@Service
public class PremierService {
  private final SecondService second;

  public PremierService(SecondService second) {
    this.second = second;
  }

  public int traiter(int n) {
    return second.relancer(n);
  }
}
`,
  );
  await j(
    'SecondService.java',
    `package com.ex.geant;

import org.springframework.stereotype.Service;

@Service
public class SecondService {
  private final PremierService premier;
  private final GeantRepository repository;

  public SecondService(PremierService premier, GeantRepository repository) {
    this.premier = premier;
    this.repository = repository;
  }

  public int relancer(int n) {
    if (n > 3) return premier.traiter(n - 1);
    repository.save(new Geant());
    return n;
  }
}
`,
  );
  await j(
    'Geant.java',
    `package com.ex.geant;

import jakarta.persistence.*;

@Entity
@Table(name = "geants")
public class Geant {
  @Id
  private Long id;
}
`,
  );
  await j(
    'GeantRepository.java',
    `package com.ex.geant;

import org.springframework.data.jpa.repository.JpaRepository;

public interface GeantRepository extends JpaRepository<Geant, Long> {}
`,
  );
  return root;
}
