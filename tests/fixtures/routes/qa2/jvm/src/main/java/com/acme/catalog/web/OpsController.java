package com.acme.catalog.web;

import org.springframework.web.bind.annotation.*;

// ops.base exists only in application-prod.yml: the route must stay partial.
@RestController
@RequestMapping("${ops.base}")
public class OpsController {

    @GetMapping("/health")
    public String health() {
        return "ok";
    }
}
