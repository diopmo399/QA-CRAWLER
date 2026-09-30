import { Component } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { UserService } from '../user.service';

@Component({
  selector: 'app-create-user',
  templateUrl: './create-user.component.html',
})
export class CreateUserComponent {
  form = this.fb.group({
    firstName: ['', [Validators.required, Validators.maxLength(100)]],
    contact: ['', [Validators.required, Validators.email]],
    phone: [''],
  });

  constructor(
    private fb: FormBuilder,
    private userService: UserService,
  ) {}

  save(): void {
    const request = {
      firstName: this.form.value.firstName,
      email: this.form.controls.contact.value,
      backupEmail: this.form.get('phone')?.value,
      [this.dynamicKey()]: this.form.value.firstName,
    };
    this.userService.create(request);
  }

  private dynamicKey(): string {
    return 'x';
  }
}
