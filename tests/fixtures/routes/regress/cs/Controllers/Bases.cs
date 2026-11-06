using Microsoft.AspNetCore.Mvc;

namespace Rg.Api;

// B7: inherited actions, an override (no duplicate), and an abstract base nobody derives from (no route, reported).
[ApiController]
[Route("api/[controller]")]
public abstract class EntityController : ControllerBase
{
    [HttpGet] public virtual IActionResult All() => Ok();
    [HttpGet("{id}")] public virtual IActionResult One(int id) => Ok();
}

public class InvoicesController : EntityController
{
    [HttpGet("{id}")] public override IActionResult One(int id) => Ok();
}

public abstract class OrphanBase : ControllerBase
{
    [HttpGet("orphan-base")] public IActionResult Nope() => Ok();
}
