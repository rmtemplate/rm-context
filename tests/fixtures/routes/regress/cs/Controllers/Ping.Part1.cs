using Microsoft.AspNetCore.Mvc;

namespace Rg.Api;

// B6 negative: no part of this partial controller declares [Route].
public partial class PingController : ControllerBase
{
    [HttpGet("ping")] public IActionResult Ping() => Ok();
}
