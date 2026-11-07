package org.springframework.cloud.openfeign;
import java.lang.annotation.*;
@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.TYPE)
public @interface FeignClient { String value() default ""; String name() default ""; String url() default ""; String path() default ""; }
