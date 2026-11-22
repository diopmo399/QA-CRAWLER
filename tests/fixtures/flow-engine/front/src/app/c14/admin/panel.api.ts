import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { LIST_URL } from '@c14-shared';

@Injectable({ providedIn: 'root' })
export class AdminPanelApi {
  constructor(private http: HttpClient) {}

  list(): Observable<string[]> {
    return this.http.get<string[]>(LIST_URL);
  }
}
