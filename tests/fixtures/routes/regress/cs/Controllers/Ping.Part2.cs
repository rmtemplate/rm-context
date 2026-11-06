using Microsoft.AspNetCore.Mvc;

namespace Rg.Api;

public partial class PingController
{
    [HttpDelete("ping/{id}")] public IActionResult Remove(int id) => Ok();
}
