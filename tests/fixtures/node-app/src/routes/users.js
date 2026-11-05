import express from 'express';
import { query } from '../db';

const router = express.Router();

router.get('/users', async (req, res) => {
  res.json(await query('SELECT id, email FROM users'));
});

router.post('/users', async (req, res) => {
  // Business rule: email must be unique (enforced by DB constraint).
  await query('INSERT INTO users (email) VALUES ($1)', [req.body.email]);
  res.status(201).end();
});

export default router;
