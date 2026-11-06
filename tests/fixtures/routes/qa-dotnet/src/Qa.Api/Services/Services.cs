namespace Qa.Api;

public interface IOrderService
{
    object ListAll();
    object Find(int id);
}

public class OrderService : IOrderService
{
    private readonly ShopDb _db;
    public OrderService(ShopDb db) { _db = db; }
    public object ListAll() => _db.Orders.ToList();
    public object Find(int id) => _db.Orders.Find(id);
}

public interface IAccountService { object Load(int id); }
public class AccountService : IAccountService { public object Load(int id) => null; }
public class CachedAccountService : IAccountService { public object Load(int id) => null; }

// Never injected anywhere: must not be linked by name similarity.
public class UserService { public object Load(int id) => null; public object Charge(object r) => null; }

public interface IPaymentService { object Charge(PayRequest r); }
public class PaymentService : IPaymentService { public object Charge(PayRequest r) => null; }
