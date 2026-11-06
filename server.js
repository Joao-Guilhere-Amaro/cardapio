const express = require('express'), fs = require('fs'), path = require('path');
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) {}
const app = express(), PORT = process.env.PORT || cfg.porta || 3000, PIN = String(process.env.PIN || cfg.pin || '1234');
const lerMenu = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8'));   // relido a cada acesso: editar o menu não exige reiniciar
const DB = path.join(__dirname, 'db.json');
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db = { mesas: Array.from({ length: 10 }, (_, i) => String(i + 1)), pedidos: [], seq: 0 };
if (fs.existsSync(DB)) db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 1));

// ---- tempo real (Server-Sent Events) ----
let clientes = [];
const emitir = (tipo, dados = {}) => clientes.forEach(r => r.write(`event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`));
const auth = (req, res, next) => (req.get('x-pin') || req.query.pin) === PIN ? next() : res.status(401).json({ erro: 'PIN inválido' });

app.get('/api/eventos', auth, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n'); clientes.push(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); clientes = clientes.filter(c => c !== res); });
});

// ---- cliente (público) ----
app.get('/api/menu', (_, res) => { try { res.json(lerMenu()); } catch (e) { res.status(500).json({ erro: 'menu.json inválido' }); } });
app.get('/api/mesas', (_, res) => res.json(db.mesas));
app.get('/api/pedidos/:id', (req, res) => {
  const p = db.pedidos.find(x => x.id === +req.params.id);
  p ? res.json({ id: p.id, status: p.status }) : res.status(404).json({ erro: 'não encontrado' });
});
app.post('/api/pedidos', (req, res) => {
  const { mesa, itens, obs } = req.body || {};
  if (!db.mesas.includes(String(mesa))) return res.status(400).json({ erro: 'Mesa inválida' });
  if (!Array.isArray(itens) || !itens.length || itens.length > 40) return res.status(400).json({ erro: 'Pedido vazio' });
  let menu; try { menu = lerMenu(); } catch (e) { return res.status(500).json({ erro: 'Cardápio indisponível' }); }
  const lista = [];
  for (const i of itens) {                      // preço e nome vêm do servidor, nunca do celular do cliente
    const p = menu.pratos.find(x => x.id === i.id);
    if (!p) return res.status(400).json({ erro: 'Prato inválido' });
    lista.push({ nome: p.nome, preco: +p.preco, qtd: Math.min(20, Math.max(1, parseInt(i.qtd) || 1)) });
  }
  const pedido = { id: ++db.seq, mesa: String(mesa), itens: lista, obs: String(obs || '').slice(0, 200),
    total: lista.reduce((a, i) => a + i.preco * i.qtd, 0), status: 'novo', criadoEm: new Date().toISOString() };
  db.pedidos.push(pedido); save(); emitir('novo', pedido);
  res.json({ id: pedido.id, status: pedido.status });
});

// ---- recepção (exige PIN) ----
app.get('/api/painel', auth, (_, res) => res.json(db));
app.patch('/api/pedidos/:id', auth, (req, res) => {
  const p = db.pedidos.find(x => x.id === +req.params.id);
  if (!p || !['novo', 'preparando', 'pronto', 'entregue', 'cancelado'].includes(req.body.status)) return res.status(400).json({ erro: 'inválido' });
  p.status = req.body.status; save(); emitir('atualizado', p); res.json(p);
});
app.post('/api/mesas', auth, (req, res) => {
  const nome = String(req.body.nome || '').trim().slice(0, 20);
  if (!nome || db.mesas.includes(nome)) return res.status(400).json({ erro: 'Nome vazio ou já existe' });
  db.mesas.push(nome); save(); emitir('mesas'); res.json(db.mesas);
});
app.delete('/api/mesas/:nome', auth, (req, res) => {
  db.mesas = db.mesas.filter(m => m !== req.params.nome); save(); emitir('mesas'); res.json(db.mesas);
});
app.post('/api/mesas/:nome/fechar', auth, (req, res) => {   // fecha a conta: libera a mesa
  db.pedidos.forEach(p => { if (p.mesa === req.params.nome && !['pago', 'cancelado'].includes(p.status)) p.status = 'pago'; });
  save(); emitir('mesas'); res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => console.log((PIN === '1234' ? '⚠  Troque o PIN padrão em config.json\n' : '') + (`Cardápio:  http://localhost:${PORT}/?mesa=1\nPainel:    http://localhost:${PORT}/painel.html  (PIN: ${PIN})`)));
