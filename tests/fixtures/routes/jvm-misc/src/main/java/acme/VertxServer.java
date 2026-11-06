package acme;

import io.vertx.core.Vertx;
import io.vertx.ext.web.Router;

public class VertxServer {
    public void start(Vertx vertx) {
        Router router = Router.router(vertx);
        router.get("/vx/ping").handler(ctx -> ctx.end("pong"));
        router.post("/vx/items").handler(this::create);
        router.route("/vx/static/*").handler(ctx -> ctx.next());
    }

    void create(io.vertx.ext.web.RoutingContext ctx) {
    }
}
