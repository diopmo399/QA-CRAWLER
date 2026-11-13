import { Injectable } from '@angular/core';
import { AliasAction, AliasApi } from './c01.api';

@Injectable({ providedIn: 'root' })
export class AliasStore {
  constructor(private api: AliasApi) {}

  dispatch(action: AliasAction): void {
    switch (action.type) {
      case 'LOAD':
        this.api.list().subscribe();
        break;
      case 'SAVE':
        this.api.save().subscribe();
        break;
      case 'REJECT':
        this.api.remove().subscribe();
        break;
    }
  }
}
