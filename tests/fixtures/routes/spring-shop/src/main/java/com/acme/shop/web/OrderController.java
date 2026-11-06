package com.acme.shop.web;

import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("${api.base-path}/orders")
public class OrderController {

    // Multiple paths and multiple methods on one handler.
    @RequestMapping(value = {"/{id}", "/by-id/{id}"}, method = {RequestMethod.GET, RequestMethod.HEAD})
    public String get(@PathVariable("id") String orderId) {
        return orderId;
    }

    @PutMapping(path = "/{id}", consumes = MediaType.APPLICATION_JSON_VALUE)
    @PreAuthorize("hasRole('ADMIN')")
    public void update(@PathVariable String id, @RequestBody String body) {
    }

    @DeleteMapping(ApiPaths.ITEMS)
    public void deleteItems(@PathVariable String id, @RequestParam(name = "sku", required = false) String sku) {
    }

    /*
    @GetMapping("/commented-out")
    public void ignored() {}
    */
}
