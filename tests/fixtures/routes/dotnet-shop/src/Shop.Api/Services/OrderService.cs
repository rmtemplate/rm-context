using Shop.Api.Data;
using Shop.Api.Models;

namespace Shop.Api.Services;

public interface IOrderService
{
    IEnumerable<Order> List();
    Order? Find(Guid id);
    Task<Order> Create(CreateOrderDto dto);
}

public class OrderService : IOrderService
{
    private readonly ShopDbContext _db;
    public OrderService(ShopDbContext db) { _db = db; }
    public IEnumerable<Order> List() => _db.Orders.ToList();
    public Order? Find(Guid id) => _db.Orders.Find(id);
    public async Task<Order> Create(CreateOrderDto dto)
    {
        var order = new Order { Sku = dto.Sku };
        _db.Orders.Add(order);
        await _db.SaveChangesAsync();
        return order;
    }
}
