import { Component, OnInit, inject } from '@angular/core';
import { User } from './user.models';
import { UserService } from './user.service';

@Component({
  selector: 'app-users',
  template: `<h1>Utilisateurs</h1>
    <a routerLink="/users/new">Nouvel utilisateur</a>
    @for (user of users; track user.id) {
      <span>{{ user.email }}</span>
      <button (click)="remove(user)">Delete</button>
    }`,
})
export class UsersComponent implements OnInit {
  private readonly service = inject(UserService);
  users: User[] = [];

  ngOnInit(): void {
    this.service.list().subscribe((users) => {
      this.users = users;
    });
  }

  remove(user: User): void {
    this.service.remove(user.id).subscribe(() => {
      this.users = this.users.filter((entry) => entry.id !== user.id);
    });
  }
}
