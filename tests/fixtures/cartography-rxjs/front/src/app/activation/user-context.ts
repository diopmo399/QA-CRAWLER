import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UserContext {
  private readonly perms = new BehaviorSubject<string[]>([]);
  readonly permissions$ = this.perms.asObservable();
}
