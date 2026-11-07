import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CycleA {
  constructor(private b: CycleB) {}
  ping(): void {
    this.b.pong();
  }
}

@Injectable({ providedIn: 'root' })
export class CycleB {
  constructor(private a: CycleA) {}
  pong(): void {
    this.a.ping();
  }
}
