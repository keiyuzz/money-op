const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA     = path.join(DATA_DIR, 'data.json');

// Auth
const AUTH_USER      = process.env.DASHBOARD_USER || null;
const AUTH_PASS      = process.env.DASHBOARD_PASS || null;
const AUTH_ENABLED   = !!(AUTH_USER && AUTH_PASS);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// Middleware
app.use(cors());
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: true }));

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

// Helpers
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

// Auto backup CSV
function generateBackup() {
  try {
    const d = load();
    const dir = path.join(DATA_DIR, 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const file = path.join(dir, 'backup-' + date + '.csv');
    const header = 'id,tipo,cat,desc,valor,qtd,dia,hora,source\n';
    const rows = (d.entries || []).map(e =>
      e.id + ',' + e.tipo + ',' + e.cat + ',"' + (e.desc||'').replace(/"/g,'""') + '",' + e.valor + ',' + (e.qtd||0) + ',' + (e.dia||'') + ',' + (e.hora||'') + ',' + (e.source||'manual')
    ).join('\n');
    fs.writeFileSync(file, header + rows);
    const files = fs.readdirSync(dir).filter(f => f.startsWith('backup-')).sort();
    if (files.length > 30) files.slice(0, files.length - 30).forEach(f => fs.unlinkSync(path.join(dir, f)));
    console.log('[BACKUP] Gerado: ' + file);
  } catch (e) { console.error('[BACKUP] Erro:', e.message); }
}

setInterval(generateBackup, 6 * 60 * 60 * 1000);
setTimeout(generateBackup, 8000);

// API
app.get('/api/data', (req, res) => res.json(load()));

app.get('/api/config', (req, res) => {
  const base = req.protocol + '://' + req.get('host');
  res.json({ webhookUrl: base + '/webhook' });
});

app.get('/api/criativos', (req, res) => res.json(load().criativos || []));
app.post('/api/criativos', (req, res) => {
  const d = load();
  d.criativos = d.criativos || [];
  d.criativos.unshift({ ...req.body, id: Date.now() });
  save(d); res.json({ ok: true });
});
app.delete('/api/criativos/:id', (req, res) => {
  const d = load();
  d.criativos = (d.criativos || []).filter(c => c.id !== parseInt(req.params.id));
  save(d); res.json({ ok: true });
});

app.get('/api/decisoes', (req, res) => res.json(load().decisoes || []));
app.post('/api/decisoes', (req, res) => {
  const d = load();
  d.decisoes = d.decisoes || [];
  d.decisoes.unshift({ ...req.body, id: Date.now() });
  save(d); res.json({ ok: true });
});
app.delete('/api/decisoes/:id', (req, res) => {
  const d = load();
  d.decisoes = (d.decisoes || []).filter(x => x.id !== parseInt(req.params.id));
  save(d); res.json({ ok: true });
});

app.get('/api/meta', (req, res) => res.json({ meta: load().meta || 0 }));
app.post('/api/meta', (req, res) => {
  const d = load();
  d.meta = parseFloat(req.body.meta) || 0;
  save(d); res.json({ ok: true });
});

app.post('/api/entry', (req, res) => {
  const d = load();
  d.entries.push({
    id: Date.now(), tipo: req.body.tipo, cat: req.body.cat,
    desc: req.body.desc, valor: parseFloat(req.body.valor),
    qtd: parseInt(req.body.qtd) || 0,
    platform: req.body.platform || '',
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
  if (req.body.confirm !== true) return res.status(400).json({ error: 'Confirmação necessária' });
  generateBackup();
  save({ entries: [], leads: 0, pendingCount: 0, webhookLog: [], rawLog: [] });
  res.json({ ok: true });
});

app.get('/api/backup', (req, res) => {
  generateBackup();
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(DATA_DIR, 'backups', 'backup-' + date + '.csv');
  if (!fs.existsSync(file)) return res.json({ error: 'Backup não encontrado' });
  res.setHeader('Content-Disposition', 'attachment; filename="moneyop-' + date + '.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(fs.readFileSync(file));
});

app.get('/api/rawlog', (req, res) => res.json(load().rawLog || []));

// WEBHOOK Sharkbot
app.post('/webhook', (req, res) => {
  // Valida assinatura HMAC-SHA256
  if (WEBHOOK_SECRET) {
    const sig      = req.headers['x-webhook-signature'] || '';
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody || '').digest('hex');
    const valid    = sig === expected || sig === 'sha256=' + expected;
    if (!valid) {
      console.log('[WH] Assinatura inválida — bloqueado');
      return res.status(401).json({ error: 'Assinatura inválida' });
    }
  }

  const d    = load();
  const body = req.body;

  d.rawLog = d.rawLog || [];
  d.rawLog.unshift({ ts: Date.now(), dia: todayBR(), hora: nowBR(), body });
  if (d.rawLog.length > 100) d.rawLog = d.rawLog.slice(0, 100);

  const event    = (body.event || '').toLowerCase().trim();
  const data     = body.data || body;
  const tx       = data.transaction || {};
  const flow     = data.flow || {};
  const customer = data.customer || {};
  const tracking = data.tracking || {};

  const valor   = parseFloat(tx.amount || 0);
  const produto = tx.plan_name || flow.name || body.bot?.username || '';
  const lead_id = customer.telegram_id || '';
  const utm     = tracking.utm_source ? tracking.utm_source + (tracking.utm_campaign ? '/' + tracking.utm_campaign : '') : '';

  d.webhookLog = d.webhookLog || [];
  d.webhookLog.unshift({ ts: Date.now(), dia: todayBR(), hora: nowBR(), event: event || 'desconhecido', raw: body });
  if (d.webhookLog.length > 50) d.webhookLog = d.webhookLog.slice(0, 50);

  if (event === 'payment_approved') {
    d.entries.push({
      id: Date.now(), tipo: 'faturamento', cat: 'venda',
      desc: 'Venda aprovada' + (produto ? ' · ' + produto : '') + (utm ? ' [' + utm + ']' : '') + ' (webhook)',
      valor, qtd: 1, dia: todayBR(), hora: nowBR(), source: 'webhook',
      lead_id, utm,
      sales_code: tx.sales_code || '',
      flow_name: flow.name || '',
      bot_username: data.bot?.username || '',
      plan_name: tx.plan_name || '',
      utm_source: tracking.utm_source || '',
      utm_campaign: tracking.utm_campaign || '',
      utm_medium: tracking.utm_medium || '',
      utm_content: tracking.utm_content || '',
      utm_term: tracking.utm_term || '',
      payment_type: tx.type || '',
      ts: Date.now()
    });
    console.log('[WH] Venda · ' + produto + ' · R$' + valor + ' · lead=' + lead_id);

  } else if (event === 'payment_created') {
    d.pendingCount = (d.pendingCount || 0) + 1;
    console.log('[WH] PIX gerado · ' + produto + ' · R$' + valor + ' · lead=' + lead_id);

  } else if (event === 'user_joined') {
    d.leads = (d.leads || 0) + 1;
    console.log('[WH] Novo lead · ' + (customer.first_name || '') + ' · ' + lead_id + (utm ? ' · utm=' + utm : ''));

  } else if (event === 'payment_refunded' || event === 'chargeback') {
    d.entries.push({
      id: Date.now(), tipo: 'gasto', cat: 'reembolso',
      desc: 'Reembolso' + (produto ? ' · ' + produto : '') + ' (webhook)',
      valor, qtd: 0, dia: todayBR(), hora: nowBR(), source: 'webhook',
      lead_id, ts: Date.now()
    });
    console.log('[WH] Reembolso · R$' + valor);

  } else {
    console.log('[WH] Evento desconhecido: "' + event + '"');
    console.log('[WH] Body:', JSON.stringify(body));
  }

  save(d);
  res.json({ ok: true, event, received: true });
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), auth: AUTH_ENABLED }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Start
app.listen(PORT, () => {
  console.log('\nMoneyOp Dashboard');
  console.log('   http://localhost:' + PORT);
  console.log('   Webhook:   /webhook');
  console.log('   Auth:      ' + (AUTH_ENABLED ? 'ATIVO' : 'Desativado'));
  console.log('   Data dir:  ' + DATA_DIR + '\n');
});
