import { Component, inject } from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { UserService } from '../user.service';

@Component({
  selector: 'app-contacts',
  template: `
    <input type="text" formControlName="primaryContact" />
    <input type="text" formControlName="secondaryContact" />
  `,
})
export class ContactsComponent {
  private fb = inject(FormBuilder);
  private users = inject(UserService);
  form = this.fb.group({ primaryContact: [''], secondaryContact: [''] });

  save(id: string): void {
    const { primaryContact, secondaryContact } = this.form.getRawValue();
    this.users.addContacts(id, { primaryEmail: primaryContact, secondaryEmail: secondaryContact });
  }
}
