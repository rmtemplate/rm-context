package com.qa.web;

import java.util.List;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import com.qa.svc.ProductService;
import com.qa.svc.Product;
import static com.qa.web.Paths.ITEMS;

/* @RequestMapping("/ghost") */
@RestController
@RequestMapping(value = {"${api.base}/products", "/legacy/products"}, produces = "application/json")
public class ProductController {
    private final ProductService service;

    public ProductController(ProductService service) { this.service = service; }

    // @GetMapping("/commented")
    @GetMapping
    public List<Product> list() { return service.findAll(); }

    @GetMapping(path = "/{id:[0-9]+}")
    public Product get(@PathVariable("id") long id) {
        String s = "@GetMapping(\"/fake\")";
        return service.findById(id);
    }

    @RequestMapping(value = "/search", method = {RequestMethod.GET, RequestMethod.POST})
    public List<Product> search(@RequestParam(required = false) String q) { return service.findAll(); }

    @PostMapping(value = ITEMS, consumes = MediaType.APPLICATION_JSON_VALUE)
    public Product add(@RequestBody Product p) { return p; }

    @DeleteMapping({"/{id}", "/{id}/purge"})
    public void delete(@PathVariable long id) { }

    @RequestMapping("/any")
    public String any() { return ""; }
}
