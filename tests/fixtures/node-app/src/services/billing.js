import { query } from '../db';

export async function chargeOrder(orderId) {
  const [order] = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const resp = await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
  await query('UPDATE orders SET paid = true WHERE id = $1', [orderId]);
  return resp.ok;
}
