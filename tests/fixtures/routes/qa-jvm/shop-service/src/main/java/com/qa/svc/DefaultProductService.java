package com.qa.svc;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class DefaultProductService implements ProductService {
    private final ProductRepository repo;
    public DefaultProductService(ProductRepository repo) { this.repo = repo; }
    public List<Product> findAll() { return repo.findAll(); }
    public Product findById(long id) { return repo.findById(id).orElse(null); }
}
