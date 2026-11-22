import { Injectable } from '@angular/core';
import { LooseAction, LooseApi } from './c10.api';

@Injectable({ providedIn: 'root' })
export class LooseStore {
  constructor(private api: LooseApi) {}

  dispatch(action: LooseAction): void {
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
