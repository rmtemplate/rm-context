package com.qa.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("${missing.prefix:/fallback}/x")
class FallbackController {
    @GetMapping("/y")
    public String y() { return "y"; }
}

@RestController
@RequestMapping("${totally.missing}/z")
class MissingController {
    @GetMapping("/w")
    public String w() { return "w"; }
}

@RestController
@RequestMapping("${app.paths.admin}")
class AdminController {
    @GetMapping("/stats")
    public String stats() { return "s"; }
}

@RestController
@RequestMapping("${catalog.prefix}")
class CatalogController {
    @GetMapping("/entries")
    public String entries() { return "e"; }
}
