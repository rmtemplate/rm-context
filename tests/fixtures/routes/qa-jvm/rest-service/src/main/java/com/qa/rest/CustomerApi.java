package com.qa.rest;

import jakarta.ws.rs.*;

@Path("/customers")
public interface CustomerApi {
    @GET
    @Path("{id}")
    String get(@PathParam("id") long id);
}

class CustomerApiImpl implements CustomerApi {
    @Override
    public String get(long id) { return ""; }
}
