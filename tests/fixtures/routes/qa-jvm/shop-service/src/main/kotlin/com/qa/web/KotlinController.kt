package com.qa.web

import org.springframework.web.bind.annotation.*
import com.qa.svc.ProductService
import com.qa.svc.Product

@RestController
@RequestMapping("/kt")
class KotlinController(private val svc: ProductService) {
    @GetMapping(value = ["/a", "/b"])
    fun ab(): String = "x"

    @GetMapping(path = arrayOf("/c", "/d"))
    fun cd(): String = "y"

    @PostMapping("/e/{id}")
    fun e(@PathVariable id: Long): Product = svc.findById(id)
}
