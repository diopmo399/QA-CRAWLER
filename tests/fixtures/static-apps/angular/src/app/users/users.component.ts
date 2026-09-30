import { Component } from '@angular/core';

@Component({ selector: 'app-users', template: `<a [routerLink]="['/administration', 'users', 'new']">Créer</a>` })
export class UsersComponent {}
