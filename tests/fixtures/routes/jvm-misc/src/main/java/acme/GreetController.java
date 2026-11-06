package acme;

import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;

@Controller("/greet")
public class GreetController {

    @Get("/{name}{?lang}")
    public String hello(String name, String lang) {
        return "hi " + name;
    }

    @Post
    public void save(String body) {
    }
}
