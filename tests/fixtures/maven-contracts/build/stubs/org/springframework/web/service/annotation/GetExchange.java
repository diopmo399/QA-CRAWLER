package org.springframework.web.service.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD)
public @interface GetExchange { String value() default ""; String url() default ""; }
