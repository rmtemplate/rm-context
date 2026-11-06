using Shop.Api.Data;
using Shop.Api.Models;

namespace Shop.Api.Services;

public interface IUserService
{
    IEnumerable<User> GetAll();
    User? Find(int id);
    void Create(User user);
    void Delete(int id);
}

public class UserService : IUserService
{
    private readonly ShopDbContext _db;

    public UserService(ShopDbContext db) => _db = db;

    public IEnumerable<User> GetAll() => _db.Users.ToList();

    public User? Find(int id) => _db.Users.Find(id);

    public void Create(User user)
    {
        _db.Users.Add(user);
        _db.SaveChanges();
    }

    public void Delete(int id) => _db.Users.Remove(Find(id)!);
}
