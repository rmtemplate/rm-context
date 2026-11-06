namespace Shop.Api;

public static class ApiRoutes
{
    public const string Base = "/api/v1";

    public static class Products
    {
        public const string Root = Base + "/products";
        public const string ById = "{id:int}";
    }
}
