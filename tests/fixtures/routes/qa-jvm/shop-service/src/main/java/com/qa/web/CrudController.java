package com.qa.web;

import java.util.List;
import org.springframework.web.bind.annotation.*;

public abstract class CrudController<T> {
    @GetMapping("/{id}")
    public T one(@PathVariable Long id) { return null; }

    @GetMapping
    public List<T> all() { return null; }
}
