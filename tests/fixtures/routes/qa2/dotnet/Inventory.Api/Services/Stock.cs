namespace Inventory.Api.Services;

public interface IStockReader
{
    Task<object> Read(string sku);
    IReadOnlyDictionary<string, List<int>> Summary();
}

public class StockReader : IStockReader
{
    public Task<object> Read(string sku) => Task.FromResult<object>(sku);
    public IReadOnlyDictionary<string, List<int>> Summary() => new Dictionary<string, List<int>>();
}

// Never injected anywhere: must not be linked to WarehouseController just because the names look related.
public class WarehouseService
{
    public object Read(string sku) => sku;
    public void Summary() { }
}
