import { Component } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-dashboard',
  template: `<h1>Tableau de bord</h1><a routerLink="/reports/monthly">Rapports</a>`,
})
export class DashboardComponent {
  constructor(private router: Router) {}

  openAdministration(): void {
    this.router.navigate(['/administration', 'users']);
  }
}
