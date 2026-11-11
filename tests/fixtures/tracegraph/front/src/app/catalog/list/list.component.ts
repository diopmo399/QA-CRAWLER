import { Component } from '@angular/core';
import { CatalogService } from './catalog.service';

/** Même nom de classe que l'autre ListComponent, dans un autre dossier. */
@Component({
  selector: 'app-catalog-list',
  template: '<button type="button" (click)="refresh()">Rafraîchir</button>',
})
export class ListComponent {
  rows: string[] = [];

  constructor(private service: CatalogService) {}

  refresh(): void {
    this.service.load().subscribe((rows) => (this.rows = rows));
  }
}
