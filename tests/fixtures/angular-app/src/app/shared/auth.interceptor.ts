import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (request, next) =>
  next(request.clone({ setHeaders: { 'x-requested-with': 'dossiers' } }));
