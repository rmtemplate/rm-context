using Microsoft.AspNetCore.Builder;
using Qa.Api;
using Qa.Api.Endpoints;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// app.MapGet("/commented", () => "x");
var api = app.MapGroup("/api").RequireAuthorization().WithTags("api");
var v1 = api.MapGroup("v1");
var users = v1.MapGroup("/users").WithTags("users");
users.MapGet("/", (IUserQueries q) => q.All());
users.MapGet("/{id:int}", (int id, IUserQueries q) => q.ById(id)).WithName("GetUser");
users.MapPost("", async (CreateUser cmd, IUserQueries q) => await q.Add(cmd));
users.MapMethods("/{id}/touch", new[] { "PATCH", "OPTIONS" }, (int id) => Results.Ok());
v1.MapProductEndpoints();
OrdersModule.Register(v1.MapGroup("orders"));
Shared.MapStatus(app.MapGroup("/api/alpha"));
Shared.MapStatus(app.MapGroup("/api/beta"));
app.MapGroup(Routes.V1 + "/const-group").MapGet("ping", () => "pong");
var tenant = app.MapGroup(builder.Configuration["TenantPrefix"]!);
tenant.MapGet("/settings", () => "s");
app.MapGet("/health/live", () => "ok").AllowAnonymous();
app.MapFallback(() => "fallback");
app.Run();

public record CreateUser(string Name);
