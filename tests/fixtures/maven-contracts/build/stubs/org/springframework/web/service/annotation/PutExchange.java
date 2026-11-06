package org.springframework.web.service.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD)
public @interface PutExchange { String value() default ""; String url() default ""; }
