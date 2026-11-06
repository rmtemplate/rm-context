using Microsoft.AspNetCore.Routing;
using Shop.Api.Services;

namespace Shop.Api.Endpoints;

public static class AdminEndpoints
{
    public static RouteGroupBuilder MapAdminEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/users", (IUserService users) => users.GetAll());
        group.MapDelete("/users/{id:int}", (int id, IUserService users) => users.Delete(id));
        return group;
    }
}
