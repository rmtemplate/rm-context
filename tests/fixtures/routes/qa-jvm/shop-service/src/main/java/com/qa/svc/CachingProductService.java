package com.qa.svc;

import java.util.List;

public class CachingProductService implements ProductService {
    public List<Product> findAll() { return List.of(); }
    public Product findById(long id) { return null; }
}

// Never injected: must not be linked by name similarity.
class ProductHelper { public List<Product> findAll() { return List.of(); } }
