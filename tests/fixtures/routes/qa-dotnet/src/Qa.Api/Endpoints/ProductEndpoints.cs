using Microsoft.AspNetCore.Routing;

namespace Qa.Api.Endpoints;

public static class ProductEndpoints
{
    public static RouteGroupBuilder MapProductEndpoints(this RouteGroupBuilder group)
    {
        var products = group.MapGroup("products");
        products.MapGet("{id}", GetProduct);
        products.MapDelete("{id}", (int id) => Results.NoContent());
        return group;
    }

    public static void MapOrphans(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/orphan", () => "never called");
    }

    static IResult GetProduct(int id) => Results.Ok(id);
}

public static class OrdersModule
{
    public static void Register(RouteGroupBuilder group)
    {
        group.MapGet("/", () => "orders");
        group.MapPost("/{id}/cancel", (int id) => Results.Ok());
    }
}

public static class Shared
{
    public static void MapStatus(IEndpointRouteBuilder e)
    {
        e.MapGet("/status", () => "ok");
    }
}
