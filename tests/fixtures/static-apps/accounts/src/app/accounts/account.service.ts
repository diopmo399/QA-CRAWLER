import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { CreateAccountRequest } from './account.models';

@Injectable({ providedIn: 'root' })
export class AccountService {
  lastResponse: unknown;

  constructor(private http: HttpClient) {}

  create(request: CreateAccountRequest) {
    return this.http.post('/api/accounts', request);
  }
}
