const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── Data helpers ──────────────────────────────────────────────────────────────
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
  return new Date().toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'America/Sao_Paulo'
  });
}
function nowBR() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Sao_Paulo'
  });
}

// ── API: get data ─────────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => res.json(load()));

// ── API: raw webhook log (for debugging) ─────────────────────────────────────
app.get('/api/rawlog', (req, res) => res.json(load().rawLog || []));

// ── API: add manual entry ─────────────────────────────────────────────────────
app.post('/api/entry', (req, res) => {
  const d = load();
  d.entries.push({
    id:     Date.now(),
    tipo:   req.body.tipo,
    cat:    req.body.cat,
    desc:   req.body.desc,
    valor:  parseFloat(req.body.valor),
    qtd:    parseInt(req.body.qtd) || 0,
    dia:    todayBR(),
    hora:   nowBR(),
    source: 'manual',
    ts:     Date.now()
  });
  save(d);
  res.json({ ok: true });
});

// ── API: delete entry ─────────────────────────────────────────────────────────
app.delete('/api/entry/:id', (req, res) => {
  const d = load();
  d.entries = d.entries.filter(e => e.id !== parseInt(req.params.id));
  save(d);
  res.json({ ok: true });
});

// ── API: reset ────────────────────────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  save({ entries: [], leads: 0, pendingCount: 0, webhookLog: [], rawLog: [] });
  res.json({ ok: true });
});

// ── WEBHOOK: Sharkbot receiver ────────────────────────────────────────────────
// Aceita POST /webhook
// Loga tudo no rawLog para identificar o payload real da Sharkbot
app.post('/webhook', (req, res) => {
  const d    = load();
  const body = req.body;
  const headers = {
    'x-webhook-signature': req.headers['x-webhook-signature'],
    'x-sharkbot-event':    req.headers['x-sharkbot-event'],
    'content-type':        req.headers['content-type'],
  };

  // ── Log raw completo para debug ───────────────────────────────────────────
  d.rawLog = d.rawLog || [];
  d.rawLog.unshift({ ts: Date.now(), dia: todayBR(), hora: nowBR(), headers, body });
  if (d.rawLog.length > 100) d.rawLog = d.rawLog.slice(0, 100);

  // ── Detectar evento ───────────────────────────────────────────────────────
  // A Sharkbot pode enviar o tipo do evento em:
  // - body.event
  // - body.type
  // - body.evento
  // - header x-sharkbot-event
  // Logamos tudo e tentamos normalizar com o que conhecemos até agora

  const event =
    req.headers['x-sharkbot-event'] ||
    body.event  ||
    body.type   ||
    body.evento ||
    body.status ||
    null;

  const valor   = parseFloat(body.amount || body.valor || body.value || body.price || 0);
  const produto = body.product || body.produto || body.plan || body.flow || body.bot_name || '';
  const userId  = body.user_id || body.telegram_id || body.chat_id || '';

  // ── Webhook log (visível no dashboard) ───────────────────────────────────
  d.webhookLog = d.webhookLog || [];
  d.webhookLog.unshift({
    ts: Date.now(), dia: todayBR(), hora: nowBR(),
    event: event || 'desconhecido',
    raw: body
  });
  if (d.webhookLog.length > 50) d.webhookLog = d.webhookLog.slice(0, 50);

  // ── Normalizar eventos conhecidos ─────────────────────────────────────────
  const ev = (event || '').toLowerCase();

  if (
    ev.includes('approved') || ev.includes('aprovado') ||
    ev.includes('paid')     || ev.includes('pago') ||
    ev.includes('payment')  || ev.includes('pagamento_aprovado') ||
    ev === 'pagamento aprovado'
  ) {
    // Venda aprovada
    d.entries.push({
      id:     Date.now(),
      tipo:   'faturamento',
      cat:    'venda',
      desc:   `Venda aprovada${produto ? ' · ' + produto : ''} (webhook)`,
      valor:  valor || 0,
      qtd:    1,
      dia:    todayBR(),
      hora:   nowBR(),
      source: 'webhook',
      ts:     Date.now()
    });

  } else if (
    ev.includes('pix_gerado') || ev.includes('pix gerado') ||
    ev.includes('pending')    || ev.includes('pendente') ||
    ev.includes('waiting')    || ev.includes('generated')
  ) {
    // PIX gerado — pendente
    d.pendingCount = (d.pendingCount || 0) + 1;

  } else if (
    ev.includes('lead')  || ev.includes('novo_lead') ||
    ev.includes('start') || ev.includes('new_lead')  ||
    ev === 'novo lead'
  ) {
    // Novo lead
    d.leads = (d.leads || 0) + 1;

  } else if (
    ev.includes('refund') || ev.includes('reembolso') ||
    ev.includes('chargeback')
  ) {
    // Reembolso
    d.entries.push({
      id:     Date.now(),
      tipo:   'gasto',
      cat:    'reembolso',
      desc:   `Reembolso${produto ? ' · ' + produto : ''} (webhook)`,
      valor:  valor || 0,
      qtd:    0,
      dia:    todayBR(),
      hora:   nowBR(),
      source: 'webhook',
      ts:     Date.now()
    });

  } else {
    // Evento desconhecido — logado mas não processado
    // Quando o primeiro evento real chegar, verifique /api/rawlog
    // e atualize os detectores acima
    console.log('[WEBHOOK] Evento não reconhecido. Verifique /api/rawlog');
    console.log('[WEBHOOK] Body:', JSON.stringify(body, null, 2));
    console.log('[WEBHOOK] Headers:', JSON.stringify(headers, null, 2));
  }

  save(d);
  res.json({ ok: true, event, received: true });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Serve index.html ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Money Operation Dashboard`);
  console.log(`   URL:     http://localhost:${PORT}`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook`);
  console.log(`   Raw log: http://localhost:${PORT}/api/rawlog\n`);
});
