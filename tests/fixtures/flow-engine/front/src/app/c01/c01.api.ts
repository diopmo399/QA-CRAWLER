import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type AliasAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class AliasApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c01/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c01/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c01/items/1');
  }
}
