import { Component, OnInit } from '@angular/core';
import { TodoStore } from './todo.store';

@Component({
  selector: 'app-c17',
  template: '<button (click)="remove()">Remove</button><p>{{ store.items$ | async }}</p>',
  providers: [TodoStore],
})
export class TodoComponent implements OnInit {
  constructor(readonly store: TodoStore) {}

  ngOnInit(): void {
    this.store.load();
  }

  remove(): void {
    this.store.remove('1');
  }
}
