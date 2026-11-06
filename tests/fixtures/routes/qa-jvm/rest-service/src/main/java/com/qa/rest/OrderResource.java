package com.qa.rest;

import java.util.List;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

@Path("/orders")
@Produces(MediaType.APPLICATION_JSON)
public class OrderResource {
    @GET
    public List<String> list() { return List.of(); }

    @GET
    @Path("{id: [0-9]{1,6}}")
    public String get(@PathParam("id") long id) { return ""; }

    @POST
    @Consumes("application/json")
    public Response create(String body) { return Response.ok().build(); }

    @Path("{id}/lines")
    public OrderLinesResource lines(@PathParam("id") long id) { return new OrderLinesResource(id); }
}
