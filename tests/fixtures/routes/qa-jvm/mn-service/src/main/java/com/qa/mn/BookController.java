package com.qa.mn;

import java.util.List;
import io.micronaut.core.annotation.Nullable;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.*;

@Controller("/books")
public class BookController {
    @Get(uri = "/{id}", produces = MediaType.APPLICATION_JSON)
    public String show(Long id) { return ""; }

    @Get("{?max,offset}")
    public List<String> list(@Nullable Integer max, @Nullable Integer offset) { return List.of(); }

    @Post
    public String save(@Body String b) { return b; }

    @Delete(uris = {"/{id}", "/remove/{id}"})
    public void delete(Long id) { }
}
