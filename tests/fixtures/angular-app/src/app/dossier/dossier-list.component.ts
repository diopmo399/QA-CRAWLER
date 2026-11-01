import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Dossier, DossierApiService } from './dossier-api.service';

@Component({
  selector: 'app-dossier-list',
  standalone: true,
  imports: [RouterLink],
  template: `<h1>Dossiers</h1>
    <a routerLink="/dossiers/nouveau">Nouveau dossier</a>
    <p>{{ dossiers.length }} dossier(s)</p>`,
})
export class DossierListComponent implements OnInit {
  dossiers: Dossier[] = [];

  constructor(private readonly api: DossierApiService) {}

  ngOnInit(): void {
    this.api.recents().subscribe((dossiers) => (this.dossiers = dossiers));
  }
}
