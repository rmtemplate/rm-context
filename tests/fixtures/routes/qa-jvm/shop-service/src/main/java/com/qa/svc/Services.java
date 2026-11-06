package com.qa.svc;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ProductService {
    List<Product> findAll();
    Product findById(long id);
}
