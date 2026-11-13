import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class StockApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c20/stock');
  }

  save(): Observable<void> {
    return this.http.post<void>('/api/c20/stock', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c20/stock/1');
  }
}

// Une classe utilitaire, jamais injectée : elle est construite par ceux qui s'en servent.
export class StockHelper {
  constructor(private api: StockApi) {}

  refresh(): void {
    this.api.list().subscribe();
  }
}

@Injectable({ providedIn: 'root' })
export class StockFactory {
  constructor(private api: StockApi) {}

  // Le type de retour écrit dit quelle classe est rendue.
  create(): StockHelper {
    return new StockHelper(this.api);
  }

  // Aucun type de retour écrit : seul le compilateur sait ce qui est rendu.
  build() {
    const made = new StockHelper(this.api);
    return made;
  }

  all() {
    return [this.build()];
  }

  // Un retour que rien ne type.
  loose(): any {
    const made: any = this.build();
    return made;
  }
}
