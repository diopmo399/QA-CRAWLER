import { ApplicationConfig } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { BASE_PATH } from './api/variables';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [provideHttpClient(), { provide: BASE_PATH, useValue: environment.apiBase }],
};
