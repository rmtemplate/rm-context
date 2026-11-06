package com.qa.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/customers")
public class CustomerController extends CrudController<Customer> {
    @PostMapping
    public Customer create(@RequestBody Customer c) { return c; }
}

class Customer { Long id; }
