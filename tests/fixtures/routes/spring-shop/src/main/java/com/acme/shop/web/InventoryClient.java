package com.acme.shop.web;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

// An HTTP client, not an endpoint: must not produce routes.
@FeignClient(name = "inventory")
public interface InventoryClient {
    @GetMapping("/stock/{sku}")
    int stock(String sku);
}
