import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type NamedAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class NamedApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c06/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c06/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c06/items/1');
  }
}
