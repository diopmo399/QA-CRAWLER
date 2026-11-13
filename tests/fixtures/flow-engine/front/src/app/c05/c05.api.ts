import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type MappedAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class MappedApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c05/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c05/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c05/items/1');
  }
}
