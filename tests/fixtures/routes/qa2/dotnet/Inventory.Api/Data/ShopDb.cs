using Microsoft.EntityFrameworkCore;
using System.ComponentModel.DataAnnotations.Schema;

namespace Inventory.Api.Data;

public class ShopDb : DbContext
{
    public DbSet<Invoice> Invoices => Set<Invoice>();
    public DbSet<Customer> Clients { get; set; }
    public DbSet<LedgerLine> Lines { get; set; }

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Customer>().ToTable("crm_customers");
    }
}

public class Invoice { public int Id { get; set; } }
public class Customer { public int Id { get; set; } }

[Table("ledger_lines")]
public class LedgerLine { public int Id { get; set; } }
