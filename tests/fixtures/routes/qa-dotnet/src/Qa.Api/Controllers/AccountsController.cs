using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

[ApiController]
[Route("api/accounts")]
public partial class AccountsController : ControllerBase
{
    private readonly IAccountService _accounts;

    public AccountsController(IAccountService accounts) { _accounts = accounts; }

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(_accounts.Load(id));
}
