using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

public class CustomersController : ApiControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id, [FromQuery] bool includeOrders = false) => Ok();

    [HttpDelete("{id:int}")]
    public IActionResult Delete(int id) => NoContent();

    [AcceptVerbs("GET", "HEAD", Route = "search")]
    public IActionResult Search([FromQuery(Name = "q")] string term) => Ok();

    [HttpGet("~/api/customers-legacy")]
    public IActionResult Legacy() => Ok();

    [HttpPost("[action]")]
    public IActionResult ImportAsync() => Accepted();
}
