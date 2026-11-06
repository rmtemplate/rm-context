using Microsoft.AspNetCore.Mvc;

namespace Qa.Api.Controllers;

[ApiController]
[Route("api/payments")]
public class PaymentsController(IPaymentService payments, UserService unusedUsers) : ControllerBase
{
    [HttpPost]
    public IActionResult Pay([FromBody] PayRequest r) => Ok(payments.Charge(r));
}

public record PayRequest(decimal Amount);
