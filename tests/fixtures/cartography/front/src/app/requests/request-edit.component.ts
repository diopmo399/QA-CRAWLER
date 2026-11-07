import { Component, inject, OnInit } from '@angular/core';
import { FormBuilder, Validators } from '@angular/forms';
import { UpdateRequest } from './request.models';
import { RequestService } from './request.service';

@Component({
  selector: 'app-request-edit',
  templateUrl: './request-edit.component.html',
})
export class RequestEditComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly service = inject(RequestService);
  id = '';

  form = this.fb.group({
    companyName: ['', Validators.required],
  });

  ngOnInit(): void {
    this.service.get(this.id).subscribe((request) => {
      this.form.patchValue({ companyName: request.companyName });
    });
  }

  save(): void {
    const request: UpdateRequest = {
      companyName: this.form.controls.companyName.value,
    };
    this.service.update(this.id, request).subscribe();
  }
}
