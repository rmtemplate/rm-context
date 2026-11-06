namespace Shop.Worker;

// A background service: not a web project, no routes.
public class Worker : BackgroundService
{
    private readonly Dictionary<string, string> _map = new();
    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var path = "/not/a/route";
        _map.Add("MapGet", path);
        return Task.CompletedTask;
    }
}
