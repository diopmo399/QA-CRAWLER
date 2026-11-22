import { Injectable } from '@angular/core';
import { ComponentStore } from '@ngrx/component-store';
import { mergeMap, switchMap, tap } from 'rxjs';
import { TodoApi } from './todo.api';

interface TodoState {
  items: string[];
}

@Injectable()
export class TodoStore extends ComponentStore<TodoState> {
  constructor(private api: TodoApi) {
    super({ items: [] });
  }

  readonly items$ = this.select((state) => state.items);

  readonly setItems = this.updater((state, items: string[]) => ({ ...state, items }));

  // Un effet du store de composant : l'appeler le déclenche.
  readonly load = this.effect<void>((trigger$) =>
    trigger$.pipe(switchMap(() => this.api.list().pipe(tap((items) => this.setItems(items))))),
  );

  readonly remove = this.effect<string>((id$) => id$.pipe(mergeMap(() => this.api.remove())));
}
