import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { CreateUserRequest, User } from './user.models';

@Injectable({ providedIn: 'root' })
export class UserService {
  constructor(private http: HttpClient) {}

  list() {
    return this.http.get<User[]>('/api/users');
  }

  create(request: CreateUserRequest) {
    return this.http.post<User>('/api/users', request);
  }

  remove(id: string) {
    return this.http.delete(`/api/users/${id}`);
  }
}
