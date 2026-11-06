using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

[ApiController]
[Route(@"api/verbatim")]
public class StringsController : ControllerBase
{
    [HttpGet("""raw/{id}""")]
    public IActionResult Raw(int id) => Ok();

    [HttpGet($"{Routes.Root}/interp")]
    public IActionResult Interp() => Ok();

    [HttpGet(Routes.Admin.Base + "/nested-const")]
    public IActionResult Nested() => Ok();
}
