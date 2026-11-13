import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type IndirectAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class IndirectApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c02/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c02/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c02/items/1');
  }
}
