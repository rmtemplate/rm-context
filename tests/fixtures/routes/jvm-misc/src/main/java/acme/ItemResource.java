package acme;

import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;

@Path("/items")
@Produces(MediaType.APPLICATION_JSON)
public class ItemResource {

    @GET
    public String list(@QueryParam("q") String q) {
        return "[]";
    }

    @GET
    @Path("{id}")
    public String get(@PathParam("id") long id) {
        return "{}";
    }

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    public void create(String body) {
    }

    @Path("{id}/parts")
    public PartResource parts() {
        return new PartResource();
    }
}
