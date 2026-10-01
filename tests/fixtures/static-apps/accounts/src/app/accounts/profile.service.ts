import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Profile } from './account.models';

@Injectable({ providedIn: 'root' })
export class ProfileService {
  constructor(private http: HttpClient) {}

  getProfile() {
    return this.http.get<Profile>('/api/profile');
  }
}
