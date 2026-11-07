import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { NewRequest, RequestState } from './request.models';

@Injectable({ providedIn: 'root' })
export class RequestService {
  constructor(private http: HttpClient) {}

  create(request: NewRequest) {
    return this.http.post('/api/requests', request);
  }

  loadState() {
    return this.http.get<RequestState>('/api/requests/current/state');
  }

  validate() {
    return this.http.post('/api/requests/validate', {});
  }

  refuse() {
    return this.http.post('/api/requests/refuse', {});
  }
}
