var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// Prefix comes from runtime configuration: cannot be resolved statically.
var tenant = app.MapGroup(builder.Configuration["TenantPrefix"]!);
tenant.MapGet("/ping", () => "pong");

var admin = app.MapGroup(AdminRoutes.Root).RequireAuthorization().WithTags("admin");
admin.MapDelete("/cache/{key}", (string key) => Results.NoContent());

MapReports(app.MapGroup("/reports"));

app.Run();

static void MapReports(RouteGroupBuilder g)
{
    g.MapGet("/daily", () => "daily");
}

public static class AdminRoutes
{
    public const string Root = "/admin";
}
