import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type PolyAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class PolyApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c13/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c13/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c13/items/1');
  }
}
