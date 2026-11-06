package com.acme.catalog.web;

import com.acme.catalog.domain.Item;
import com.acme.catalog.service.ItemService;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("${catalog.base}/items")
public class ItemController extends CrudController<Item, Long> {

    private final ItemService items;

    public ItemController(ItemService items) {
        this.items = items;
    }

    @GetMapping(produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<Map<String, Item>>> list() {
        return ResponseEntity.ok(items.all());
    }

    @RequestMapping(value = {"/search", "/find"}, method = {RequestMethod.GET, RequestMethod.POST})
    public java.util.List<com.acme.catalog.domain.Item>[] search(@RequestParam String q) {
        return null;
    }

    // @PostMapping("/ghost-commented")
    public String helper() {
        return "@GetMapping(\"/ghost-in-string\")";
    }
}
