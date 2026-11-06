package com.qa.svc;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;

@Entity
public class Product { @Id Long id; String name; }
