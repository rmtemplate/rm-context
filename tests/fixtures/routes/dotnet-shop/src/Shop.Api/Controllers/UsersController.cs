using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Api.Models;
using Shop.Api.Services;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    private readonly IUserService _users;

    public UsersController(IUserService users)
    {
        _users = users;
    }

    [HttpGet]
    public IActionResult GetAll() => Ok(_users.GetAll());

    [HttpGet("{id}")]
    public IActionResult GetById(int id) => Ok(_users.Find(id));

    [HttpPost]
    [Authorize(Roles = "Admin")]
    public IActionResult Create([FromBody] User user)
    {
        _users.Create(user);
        return Ok();
    }

    // Not an action.
    [NonAction]
    public void Helper() { }
}
