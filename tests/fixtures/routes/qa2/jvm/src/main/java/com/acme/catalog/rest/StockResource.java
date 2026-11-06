package com.acme.catalog.rest;

import jakarta.ws.rs.core.Response;

public class StockResource implements StockApi {
    @Override
    public Response get(String sku) {
        return Response.ok(sku).build();
    }
}
