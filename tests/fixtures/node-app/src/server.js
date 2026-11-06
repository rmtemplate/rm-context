const express = require('express');
const users = require('./routes/users');

const app = express();
app.use(express.json());
app.use('/users', users);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000);
