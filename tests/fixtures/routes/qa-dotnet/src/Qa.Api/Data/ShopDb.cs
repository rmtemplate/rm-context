using Microsoft.EntityFrameworkCore;

namespace Qa.Api;

public class ShopDb : DbContext
{
    public DbSet<Order> Orders { get; set; }
    public DbSet<Customer> Customers { get; set; }
}

public class Order { public int Id { get; set; } }
public class Customer { public int Id { get; set; } }
