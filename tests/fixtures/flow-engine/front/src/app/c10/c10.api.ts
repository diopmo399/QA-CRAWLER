import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type LooseAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class LooseApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c10/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c10/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c10/items/1');
  }
}
