import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { CreateUserRequest, User } from './user.models';

const API_KEY = 'fixture-constant-not-a-real-key-value';

@Injectable({ providedIn: 'root' })
export class UserService {
  constructor(private http: HttpClient) {}

  create(request: CreateUserRequest) {
    return this.http.post<User>('/api/users', request);
  }

  list() {
    return this.http.get<User[]>(`/api/users?token=${API_KEY}`);
  }

  addContacts(id: string, body: ContactsRequest) {
    return this.http.put(`/api/users/${id}/contacts`, body);
  }
}

interface ContactsRequest {
  primaryEmail: string;
  secondaryEmail: string;
}
