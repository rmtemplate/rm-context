package com.qa.web;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "remote", url = "http://remote")
public interface RemoteClient {
    @GetMapping("/remote/things")
    String things();
}
