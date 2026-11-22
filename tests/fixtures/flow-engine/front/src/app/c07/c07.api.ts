import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type ManyAction = { type: 'LOAD' } | { type: 'SAVE' } | { type: 'VALIDATE' } | { type: 'REJECT' };

@Injectable({ providedIn: 'root' })
export class ManyApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c07/items');
  }

  save(): Observable<{ id: string }> {
    return this.http.post<{ id: string }>('/api/c07/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c07/items/1');
  }
}
