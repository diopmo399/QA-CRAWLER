import { Injectable } from '@angular/core';
import { Subject, filter, tap } from 'rxjs';
import { LoopApi } from './c11.api';

type Beat = { type: 'PING' } | { type: 'PONG' };

@Injectable({ providedIn: 'root' })
export class LoopStore {
  private readonly beats = new Subject<Beat>();
  readonly ping$ = this.beats.pipe(
    filter((b) => b.type === 'PING'),
    tap(() => this.beats.next({ type: 'PONG' })),
  );
  readonly pong$ = this.beats.pipe(
    filter((b) => b.type === 'PONG'),
    tap(() => this.beats.next({ type: 'PING' })),
  );

  constructor(private api: LoopApi) {}

  start(): void {
    this.beats.next({ type: 'PING' });
  }

  first(depth: number): void {
    if (depth > 0) this.second(depth - 1);
  }

  private second(depth: number): void {
    this.first(depth);
    this.api.save().subscribe();
  }
}
