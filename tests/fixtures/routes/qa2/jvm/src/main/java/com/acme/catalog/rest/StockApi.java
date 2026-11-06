package com.acme.catalog.rest;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;

@Path("/stock")
public interface StockApi {
    @GET
    @Path("/{sku}")
    Response get(@PathParam("sku") String sku);
}
