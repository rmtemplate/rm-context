package com.qa.web;

import org.springframework.web.bind.annotation.*;

@RequestMapping("/accounts")
public interface AccountApi {
    @GetMapping("/{id}")
    String get(@PathVariable Long id);
}

@RestController
class AccountController implements AccountApi {
    @Override
    public String get(Long id) { return "a"; }
}
