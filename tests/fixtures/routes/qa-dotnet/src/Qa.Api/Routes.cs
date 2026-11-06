namespace Qa.Api;

public static class Routes
{
    public const string Root = "api";
    public const string V1 = Root + "/v1";
    public static readonly string Reports = "reports";

    public static class Admin
    {
        public const string Base = V1 + "/admin";
    }
}
