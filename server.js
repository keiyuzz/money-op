const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');

// ── Auth ──────────────────────────────────────────────────────────────────────
// Configure no Railway: Settings → Variables
// DASHBOARD_USER=seu_usuario  DASHBOARD_PASS=sua_senha
const AUTH_USER    = process.env.DASHBOARD_USER || null;
const AUTH_PASS    = process.env.DASHBOARD_PASS || null;
const AUTH_ENABLED = !!(AUTH_USER && AUTH_PASS);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth (webhook e health são públicos)
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path === '/health') return next();
  if (!AUTH_ENABLED) return next();
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="MoneyOp"');
    return res.status(401).send('Login necessário');
  }
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  if (u === AUTH_USER && p === AUTH_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="MoneyOp"');
  return res.status(401).send('Usuário ou senha incorretos');
});

app.use(express.static(__dirname));

// ── Helpers ───────────────────────────────────────────────────────────────────
function load() {
  if (!fs.existsSync(DATA)) {
    const d = { entries: [], leads: 0, pendingCount: 0, webhookLog: [], rawLog: [] };
    fs.writeFileSync(DATA, JSON.stringify(d, null, 2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return { entries: [], leads: 0, pendingCount: 0, webhookLog: [], rawLog: [] }; }
}
function save(d) { fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }

function todayBR() {
  return new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'America/Sao_Paulo' });
}
function nowBR() {
  return new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', timeZone:'America/Sao_Paulo' });
}

// ── Auto backup CSV ───────────────────────────────────────────────────────────
function generateBackup() {
  try {
    const d = load();
    const dir = path.join(__dirname, 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const date = new Date().toISOString().split('T')[0];
    const file = path.join(dir, `backup-${date}.csv`);
    const header = 'id,tipo,cat,desc,valor,qtd,dia,hora,source\n';
    const rows = (d.entries || []).map(e =>
      `${e.id},${e.tipo},${e.cat},"${(e.desc||'').replace(/"/g,'""')}",${e.valor},${e.qtd||0},${e.dia||''},${e.hora||''},${e.source||'manual'}`
    ).join('\n');
    fs.writeFileSync(file, header + rows);
    // Guarda apenas 30 backups
    const files = fs.readdirSync(dir).filter(f => f.startsWith('backup-')).sort();
    if (files.length > 30) files.slice(0, files.length - 30).forEach(f => fs.unlinkSync(path.join(dir, f)));
    console.log(`[BACKUP] Gerado: ${file}`);
  } catch (e) { console.error('[BACKUP] Erro:', e.message); }
}

setInterval(generateBackup, 6 * 60 * 60 * 1000); // a cada 6h
setTimeout(generateBackup, 8000);                  // ao iniciar

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => res.json(load()));

app.post('/api/entry', (req, res) => {
  const d = load();
  d.entries.push({
    id: Date.now(), tipo: req.body.tipo, cat: req.body.cat,
    desc: req.body.desc, valor: parseFloat(req.body.valor),
    qtd: parseInt(req.body.qtd) || 0,
    dia: todayBR(), hora: nowBR(), source: 'manual', ts: Date.now()
  });
  save(d); res.json({ ok: true });
});

app.delete('/api/entry/:id', (req, res) => {
  const d = load();
  d.entries = d.entries.filter(e => e.id !== parseInt(req.params.id));
  save(d); res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  generateBackup(); // backup antes de zerar
  save({ entries: [], leads: 0, pendingCount: 0, webhookLog: [], rawLog: [] });
  res.json({ ok: true });
});

app.get('/api/backup', (req, res) => {
  generateBackup();
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(__dirname, 'backups', `backup-${date}.csv`);
  if (!fs.existsSync(file)) return res.json({ error: 'Backup não encontrado' });
  res.setHeader('Content-Disposition', `attachment; filename="moneyop-${date}.csv"`);
  res.setHeader('Content-Type', 'text/csv');
  res.send(fs.readFileSync(file));
});

app.get('/api/rawlog', (req, res) => res.json(load().rawLog || []));

// ── WEBHOOK Sharkbot ──────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  const d    = load();
  const body = req.body;

  d.rawLog = d.rawLog || [];
  d.rawLog.unshift({ ts: Date.now(), dia: todayBR(), hora: nowBR(), body });
  if (d.rawLog.length > 100) d.rawLog = d.rawLog.slice(0, 100);

  const event = (
    req.headers['x-sharkbot-event'] ||
    body.event || body.type || body.evento || body.status || body.order_status || ''
  ).toLowerCase().trim();

  const valor   = parseFloat(body.amount || body.valor || body.value || body.price || 0);
  const produto = body.product || body.produto || body.bot_name || body.flow || body.name || '';

  d.webhookLog = d.webhookLog || [];
  d.webhookLog.unshift({ ts: Date.now(), dia: todayBR(), hora: nowBR(), event: event || 'desconhecido', raw: body });
  if (d.webhookLog.length > 50) d.webhookLog = d.webhookLog.slice(0, 50);

  if (['approved','aprovado','paid','pago','pagamento_aprovado','pagamento aprovado'].some(k => event.includes(k))) {
    d.entries.push({
      id: Date.now(), tipo: 'faturamento', cat: 'venda',
      desc: `Venda aprovada${produto ? ' · ' + produto : ''} (webhook)`,
      valor: valor || 0, qtd: 1, dia: todayBR(), hora: nowBR(), source: 'webhook', ts: Date.now()
    });
    console.log(`[WH] ✅ Venda · ${produto} · R$${valor}`);

  } else if (['pix','gerado','pending','waiting','pendente','pix gerado'].some(k => event.includes(k))) {
    d.pendingCount = (d.pendingCount || 0) + 1;
    console.log(`[WH] 🟡 PIX gerado · ${produto}`);

  } else if (['lead','start','novo lead','new_lead','novo_lead'].some(k => event.includes(k))) {
    d.leads = (d.leads || 0) + 1;
    console.log(`[WH] 👤 Novo lead`);

  } else if (['refund','reembolso','chargeback'].some(k => event.includes(k))) {
    d.entries.push({
      id: Date.now(), tipo: 'gasto', cat: 'reembolso',
      desc: `Reembolso${produto ? ' · ' + produto : ''} (webhook)`,
      valor: valor || 0, qtd: 0, dia: todayBR(), hora: nowBR(), source: 'webhook', ts: Date.now()
    });
    console.log(`[WH] ↩️  Reembolso · R$${valor}`);

  } else {
    console.log(`[WH] ❓ Evento desconhecido: "${event}"`);
    console.log(`[WH] Body:`, JSON.stringify(body));
    console.log(`[WH] Acesse /api/rawlog para ver o payload completo`);
  }

  save(d);
  res.json({ ok: true, event, received: true });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), auth: AUTH_ENABLED }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ MoneyOp Dashboard`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Webhook:  /webhook`);
  console.log(`   Backup:   /api/backup`);
  console.log(`   Raw log:  /api/rawlog`);
  console.log(`   Auth:     ${AUTH_ENABLED ? '🔒 ATIVO' : '⚠️  Desativado — defina DASHBOARD_USER e DASHBOARD_PASS'}\n`);
});
