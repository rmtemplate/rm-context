package com.rg;

import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

// B1/B2/B8: generic, qualified and array return types; placeholders from the default profile only.
@RestController
@RequestMapping("${api.base}/products")
public class ProductApi {
    @GetMapping public ResponseEntity<List<String>> getProducts() { return null; }
    @GetMapping("/export") public java.util.List<String> export() { return null; }
    @GetMapping("/match") public String[] match() { return null; }
    @GetMapping("/from") public Map<String, List<Integer>> from() { return null; }
}

@RestController
@RequestMapping("${api.only-prod}/x")
class ProdOnlyApi {
    @GetMapping("/y") public String y() { return ""; }
}
