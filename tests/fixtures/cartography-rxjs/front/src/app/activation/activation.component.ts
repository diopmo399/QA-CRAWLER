import { Component, OnInit } from '@angular/core';
import { combineLatest, map } from 'rxjs';
import { ActivationContext } from './activation-context';
import { ActivationService } from './activation.service';
import { CycleA } from './cycle';
import { OrphanStore } from './orphan-store';
import { UserContext } from './user-context';
import { LegacyGateway } from '../legacy/legacy-gateway';

@Component({
  selector: 'app-activation',
  templateUrl: './activation.component.html',
})
export class ActivationComponent implements OnInit {
  readonly canActivate$ = combineLatest([this.users.permissions$, this.context.status$]).pipe(
    map(([permissions, status]) => permissions.includes('ACTIVATE') && status === 'READY'),
  );

  constructor(
    public context: ActivationContext,
    private users: UserContext,
    private orphans: OrphanStore,
    private cycle: CycleA,
    private legacy: LegacyGateway,
    private service: ActivationService,
  ) {}

  ngOnInit(): void {
    this.context.load();
  }

  activate(): void {
    this.context.activate('42');
  }

  onConfirm(): void {
    this.context.activate('43');
  }

  fireOrphan(): void {
    this.orphans.fire();
  }

  forget(): void {
    this.orphans.forget();
  }

  loop(): void {
    this.cycle.ping();
  }

  old(): void {
    this.legacy.send();
  }

  listItems(): void {
    this.service.items('a').subscribe();
  }
}
