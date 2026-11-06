package org.springframework.web.service.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target({ElementType.TYPE, ElementType.METHOD})
public @interface HttpExchange { String value() default ""; String url() default ""; String method() default ""; }
