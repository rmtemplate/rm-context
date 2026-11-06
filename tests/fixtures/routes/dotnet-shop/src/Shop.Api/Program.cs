using Shop.Api;
using Shop.Api.Endpoints;
using Shop.Api.Services;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddScoped<IUserService, UserService>();
builder.Services.AddScoped<IOrderService, OrderService>();

var app = builder.Build();

app.MapControllers();

// Minimal API: nested groups resolved through local variables and a constant.
var api = app.MapGroup(ApiRoutes.Base);
var orders = api.MapGroup("/orders").RequireAuthorization();

orders.MapGet("/", (IOrderService svc) => svc.List());
orders.MapGet("/{id:guid}", GetOrder);
orders.MapPost("/", async (CreateOrderDto dto, IOrderService svc) => await svc.Create(dto));
orders.MapMethods("/{id:guid}/status", new[] { "PUT", "PATCH" }, (Guid id, OrderStatusDto status) => Results.NoContent());

// Endpoints registered by an extension method in another file.
app.MapGroup("/api/v1/admin").MapAdminEndpoints();

// app.MapGet("/old", () => "commented out routes are ignored");

app.MapHealthChecks("/health");

// The tenant prefix is computed at runtime: the route is recorded as partial, not invented.
app.MapGroup(GetTenantPrefix()).MapGet("/settings", () => Results.Ok());

app.MapFallback(() => Results.NotFound());

app.Run();

static IResult GetOrder(Guid id, IOrderService svc) => Results.Ok(svc.Find(id));
static string GetTenantPrefix() => Environment.GetEnvironmentVariable("TENANT") ?? "/t";

public record CreateOrderDto(string Sku, int Quantity);
public record OrderStatusDto(string Status);
