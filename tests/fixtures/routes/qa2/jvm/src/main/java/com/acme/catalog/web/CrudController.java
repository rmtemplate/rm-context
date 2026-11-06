package com.acme.catalog.web;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

public abstract class CrudController<T, ID> {

    @GetMapping("/{id}")
    public ResponseEntity<T> one(@PathVariable ID id) {
        return ResponseEntity.notFound().build();
    }

    @DeleteMapping("/{id}")
    public void remove(@PathVariable ID id) {
    }
}
