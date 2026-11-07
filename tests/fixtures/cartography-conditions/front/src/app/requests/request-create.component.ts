import { Component, OnInit, inject } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { NewRequest, RequestState } from './request.models';
import { RequestService } from './request.service';

@Component({
  selector: 'app-request-create',
  templateUrl: './request-create.component.html',
})
export class RequestCreateComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(RequestService);

  state: RequestState = { showCompanySection: false, showValidationSection: false, canValidate: false };
  hasPermission = false;

  form = this.fb.group({
    companyType: [''],
    companyName: ['', Validators.required],
    registrationNumber: [''],
  });

  ngOnInit(): void {
    this.service.loadState().subscribe((result) => {
      this.state = result;
    });
  }

  save(): void {
    const request: NewRequest = {
      companyType: this.form.controls.companyType.value,
      companyName: this.form.controls.companyName.value,
      registrationNumber: this.form.controls.registrationNumber.value,
    };
    this.service.create(request).subscribe();
  }

  validateRequest(): void {
    this.service.validate().subscribe();
  }

  refuse(): void {
    this.service.refuse().subscribe();
  }
}
