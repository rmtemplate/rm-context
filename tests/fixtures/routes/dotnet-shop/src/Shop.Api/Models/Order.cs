namespace Shop.Api.Models;

public class Order
{
    public Guid Id { get; set; }
    public string Sku { get; set; } = "";
}
