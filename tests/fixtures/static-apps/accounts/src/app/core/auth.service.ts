import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private roles: string[] = [];

  hasRole(role: string): boolean {
    return this.roles.includes(role);
  }
}
