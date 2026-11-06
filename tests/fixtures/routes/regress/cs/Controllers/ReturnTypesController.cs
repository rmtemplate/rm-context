using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace Rg.Api;

// B2/B3: complex return types and soft-keyword method names must not hide actions.
[ApiController]
[Route("api/rt")]
public class ReturnTypesController : ControllerBase
{
    [HttpGet("a")] public Task<object> A() => null;
    [HttpGet("b")] public ActionResult<object> B() => null;
    [HttpGet("c")] public object[] C() => null;
    [HttpGet("d")] public Dictionary<string, object> D() => null;
    [HttpGet("e")] public object E() => null;
    [HttpGet("list")] public IEnumerable<string> list() => null;
    [HttpGet("select")] public System.Collections.Generic.List<int> select() => null;
    [HttpGet("nullable")] public int? match() => null;
}
