using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public abstract class CrudController<T> : ControllerBase where T : class
{
    [HttpGet]
    public virtual IActionResult All() => Ok();

    [HttpGet("{id}")]
    public virtual IActionResult One(int id) => Ok();
}

public class CustomersController : CrudController<Customer>
{
    [HttpPost]
    public IActionResult Add([FromBody] Customer c) => Ok();
}
