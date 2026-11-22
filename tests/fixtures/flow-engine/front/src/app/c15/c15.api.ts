import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type GateKind = 'SAVE' | 'LOAD' | 'REJECT';
export interface GateAction {
  type: GateKind;
  urgent?: boolean;
}
export enum GateMode {
  Create = 'CREATE',
  Update = 'UPDATE',
  Remove = 'REMOVE',
}
export interface SaveOnly {
  type: 'SAVE';
}

@Injectable({ providedIn: 'root' })
export class GateApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>('/api/c15/items');
  }

  save(): Observable<void> {
    return this.http.post<void>('/api/c15/items', {});
  }

  remove(): Observable<void> {
    return this.http.delete<void>('/api/c15/items/1');
  }

  audit(): Observable<void> {
    return this.http.post<void>('/api/c15/audit', {});
  }
}
