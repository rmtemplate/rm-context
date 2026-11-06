using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

public partial class AccountsController
{
    [HttpDelete("{id}")]
    public IActionResult Remove(int id) => Ok();
}
