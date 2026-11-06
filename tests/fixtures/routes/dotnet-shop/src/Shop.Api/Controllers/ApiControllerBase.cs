using Microsoft.AspNetCore.Mvc;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/v2/[controller]")]
public abstract class ApiControllerBase : ControllerBase
{
}
