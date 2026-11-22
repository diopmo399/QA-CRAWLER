import { Injectable } from '@angular/core';
import { CatalogPanelApi } from './panel.api';

@Injectable({ providedIn: 'root' })
export class PanelStore {
  constructor(private api: CatalogPanelApi) {}

  load(): void {
    this.api.list().subscribe();
  }
}
