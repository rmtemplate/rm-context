using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

// [Route("api/commented")] must not become a route
/* [HttpGet("ghost")] neither */
[ApiController]
[Route(Routes.V1 + "/[controller]")]
[Route("api/legacy-orders")]
public class OrdersController : ControllerBase
{
    private readonly IOrderService _orders;

    public OrdersController(IOrderService orders) { _orders = orders; }

    [HttpGet]
    public IActionResult List() => Ok(_orders.ListAll());

    [HttpGet("{id:int:min(1)}")]
    public IActionResult Get(int id)
    {
        var s = "[HttpGet(\"fake\")]";
        return Ok(_orders.Find(id));
    }

    [HttpGet("~/orders/by-code/{code:regex(^[[A-Z]]{{3}}$)}")]
    public IActionResult ByCode(string code) => Ok();

    [HttpPost]
    [Route("")]
    public IActionResult Create([FromBody] CreateOrder cmd) => Ok();

    [
        HttpPut(
            "{id}"
        )
    ]
    public IActionResult Update(int id, [FromBody] Dictionary<string, List<int>> body) => Ok();

    [Route("[action]")]
    [HttpGet]
    public async Task<IActionResult> ExportAsync() => Ok();

    [NonAction]
    public IActionResult Helper() => Ok();
}

public record CreateOrder(string Sku, int Qty);
