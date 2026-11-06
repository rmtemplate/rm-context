package com.qa.rest;

import java.util.List;
import jakarta.ws.rs.*;

// Sub-resource returned by OrderResource.lines(): no class-level @Path.
public class OrderLinesResource {
    private final long orderId;
    public OrderLinesResource(long orderId) { this.orderId = orderId; }

    @GET
    public List<String> list() { return List.of(); }

    @DELETE
    @Path("{lineId}")
    public void remove(@PathParam("lineId") long lineId) { }
}
