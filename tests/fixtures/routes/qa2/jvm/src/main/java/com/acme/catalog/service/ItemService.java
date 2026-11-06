package com.acme.catalog.service;

import com.acme.catalog.domain.Item;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class ItemService {
    public List<Map<String, Item>> all() {
        return List.of();
    }
}
