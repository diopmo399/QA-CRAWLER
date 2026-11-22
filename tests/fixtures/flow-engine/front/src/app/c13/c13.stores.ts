import { Injectable } from '@angular/core';
import { PolyAction, PolyApi } from './c13.api';

export abstract class BaseStore {
  constructor(protected api: PolyApi) {}

  dispatch(action: PolyAction): void {
    if (action.type === 'SAVE') this.persist();
    else this.api.list().subscribe();
  }

  protected abstract persist(): void;
}

@Injectable({ providedIn: 'root' })
export class DraftStore extends BaseStore {
  protected persist(): void {
    this.api.save().subscribe();
  }
}

@Injectable({ providedIn: 'root' })
export class TrashStore extends BaseStore {
  protected persist(): void {
    this.api.remove().subscribe();
  }
}
