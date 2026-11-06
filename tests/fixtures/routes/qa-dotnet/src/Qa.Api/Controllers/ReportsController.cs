using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

[Area("Admin")]
[Route("[area]/[controller]/[action]")]
public class ReportsController : Controller
{
    public IActionResult Index() => View();

    [HttpPost]
    public IActionResult Rebuild() => Ok();
}
