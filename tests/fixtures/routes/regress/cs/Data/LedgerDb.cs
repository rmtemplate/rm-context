using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;

namespace Rg.Api;

// B9: entity → table only from mappings.
public class LedgerDb : DbContext
{
    public DbSet<Invoice> Invoices { get; set; }
    public DbSet<Entry> Entries { get; set; }
    public DbSet<Customer> People { get; set; }
    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Entry>().ToTable("ledger");
    }
}

[Table("tbl_invoice")]
public class Invoice { public int Id { get; set; } }
public class Entry { public int Id { get; set; } }
public class Customer { public int Id { get; set; } }
