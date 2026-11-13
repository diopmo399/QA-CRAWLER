import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ModeService {
  constructor(private http: HttpClient) {}

  send(mode: 'CREATE' | 'UPDATE', body: unknown): Observable<unknown> {
    if (mode === 'CREATE') return this.http.post('/api/c08/items', body);
    return this.http.put('/api/c08/items/1', body);
  }
}
