using Inventory.Api.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Inventory.Api.Controllers;

/// <summary>Warehouse stock. Example in docs: [HttpGet("ghost-from-xml-doc")]</summary>
[ApiController]
[Route("api/v{version:apiVersion}/[controller]")]
public sealed class WarehouseController(IStockReader reader) : ControllerBase
{
    [HttpGet("{sku}")]
    public async Task<ActionResult<object>> GetBySku(string sku) => Ok(await reader.Read(sku));

    [HttpGet, Route("summary")]
    public IReadOnlyDictionary<string, List<int>> Summary() => reader.Summary();

    [HttpPost("bulk")]
    [Authorize(Roles = "admin")]
    public IActionResult Bulk([FromBody] BulkRequest body) => Accepted();
}

public record BulkRequest(string[] Skus);
