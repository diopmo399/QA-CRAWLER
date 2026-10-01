import { Component, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { CreateUserRequest } from './user.models';
import { UserService } from './user.service';

@Component({
  selector: 'app-user-form',
  template: `<h1>Nouvel utilisateur</h1>
    <form [formGroup]="form" (ngSubmit)="save()">
      <input type="email" formControlName="email">
      <input type="text" formControlName="firstName">
      <button type="submit" (click)="save()">Create</button>
    </form>`,
})
export class UserFormComponent {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(UserService);
  private readonly router = inject(Router);
  errorMessage = '';

  form = this.fb.group({
    email: ['', [Validators.required, Validators.email]],
    firstName: ['', Validators.required],
  });

  save(): void {
    const request: CreateUserRequest = {
      email: this.form.controls.email.value,
      firstName: this.form.controls.firstName.value,
    };
    this.service.create(request).subscribe({
      next: () => {
        this.router.navigate(['/users']);
      },
      error: (e) => {
        if (e.status === 409 && e.error?.code === 'EMAIL_ALREADY_EXISTS') {
          this.form.controls.email.setErrors({ exists: true });
          this.errorMessage = 'Email already exists';
        }
      },
    });
  }
}
