using Asp.Versioning;
using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

[ApiController]
[ApiVersion("1.0")]
[Route(ApiRoutes.Products.Root)]
[Produces("application/json")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    [ProducesResponseType(typeof(ProductDto[]), 200)]
    public IActionResult List() => Ok();

    [HttpGet(ApiRoutes.Products.ById)]
    public ActionResult<ProductDto> Get(int id) => Ok();
}

public record ProductDto(int Id, string Name);
