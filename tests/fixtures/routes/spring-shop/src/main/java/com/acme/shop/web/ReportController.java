package com.acme.shop.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ReportController extends BaseApiController {

    @GetMapping({"/reports", "/reports/summary"})
    public String reports() {
        return "ok";
    }
}
