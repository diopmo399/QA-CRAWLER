package org.springframework.web.service.annotation;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD)
public @interface PostExchange { String value() default ""; String url() default ""; }
