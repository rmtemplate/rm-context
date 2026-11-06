using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class Inventory : ControllerBase
{
    [HttpGet("{sku}")]
    public IActionResult Get(string sku) => Ok();
}
