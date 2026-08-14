const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const zlib = require('zlib');
const app = express();

// ⭐ Versão visível em /api/version, na tela de login e no boot — confirma qual código está em produção
const APP_VERSION = '4.2.1';
const APP_STARTED_AT = new Date().toISOString();

// ============ DEPENDÊNCIAS OPCIONAIS (gracefully degrade) ============
let bcrypt = null;
try { bcrypt = require('bcryptjs'); console.log('✅ bcryptjs carregado'); }
catch(e) { console.log('⚠️ bcryptjs não instalado — login usará comparação direta (menos seguro)'); }

let rateLimit = null;
try { rateLimit = require('express-rate-limit'); console.log('✅ express-rate-limit carregado'); }
catch(e) {
    // ⭐ FIX 10/05: fail-closed. Está no package.json — se não carregar, é falha de install, não cenário normal.
    // Antes: degradava silenciosamente pra "passa tudo" → brute force no /auth/login sem limite.
    console.error('❌ express-rate-limit NÃO carregou — CRÍTICO de segurança (brute force no login fica liberado)');
    console.error('   Instale com: npm install express-rate-limit');
    throw new Error('express-rate-limit é obrigatório (segurança)');
}

// ============ WEB PUSH (notificações no celular) ============
let webpush = null;
try {
    webpush = require('web-push');
    const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
    const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('VAPID keys não configuradas no ambiente');
    webpush.setVapidDetails('mailto:admin@orion.app', VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('✅ Web Push configurado');
} catch(e) {
    webpush = null;
    console.log('⚠️ Web Push desativado — ' + e.message + ' (defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY)');
}

// Assinaturas push em memória + banco
const pushSubscriptions = new Map();

// ============ CONFIGURAÇÕES ============
// ⭐ 22/07: WHATSAPP CLOUD API OFICIAL (Meta) — canal novo pós-Evolution.
// WABA_TOKEN: token permanente do system user (whatsapp_business_messaging + management)
// WABA_ID: ID da conta WhatsApp Business (pra listar números e templates)
// WABA_PHONE_NUMBER_ID: ID do número padrão de envio (não é o telefone — é o ID que a Meta gera)
// META_WEBHOOK_VERIFY_TOKEN: string secreta que você define e repete na tela de webhook da Meta
const WABA_TOKEN = process.env.WABA_TOKEN || '';
const WABA_ID = process.env.WABA_ID || '';
const WABA_PHONE_NUMBER_ID = process.env.WABA_PHONE_NUMBER_ID || '';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
// META_GRAPH_BASE_URL: só pra testes locais (aponta pro mock) — em produção fica vazio
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || `https://graph.facebook.com/${META_GRAPH_VERSION}`;
// ⭐ 14/08: configurado = chaves no ambiente OU pelo menos 1 número cadastrado no painel com token
function isWabaConfigured() {
    if (WABA_TOKEN && WABA_PHONE_NUMBER_ID) return true;
    try { return !!db.getDb().prepare("SELECT 1 FROM official_numbers WHERE token IS NOT NULL AND token != '' LIMIT 1").get(); } catch(e) { return false; }
}
// Token certo pra falar com a Meta em nome de um número (painel primeiro, ambiente como fallback)
function waTokenFor(phoneNumberId) {
    try {
        const row = db.getDb().prepare('SELECT token FROM official_numbers WHERE phone_number_id = ?').get(String(phoneNumberId || ''));
        if (row?.token) return row.token;
    } catch(e) {}
    return WABA_TOKEN;
}
// Todas as contas (WABA + token) conhecidas: as dos números do painel + a do ambiente
function waAccounts() {
    const map = new Map();
    try {
        db.getDb().prepare("SELECT DISTINCT waba_id, token FROM official_numbers WHERE waba_id IS NOT NULL AND waba_id != '' AND token IS NOT NULL AND token != ''").all()
            .forEach(r => map.set(r.waba_id, r.token));
    } catch(e) {}
    if (WABA_ID && WABA_TOKEN && !map.has(WABA_ID)) map.set(WABA_ID, WABA_TOKEN);
    return [...map.entries()].map(([waba_id, token]) => ({ waba_id, token }));
}
// ⭐ FIX 04/05: parseInt("7m") = NaN → setTimeout(fn, NaN) dispara em 0ms (sem espera dos 7min).
// ⭐ FIX 11/05: editável no admin via settings.PIX_TIMEOUT_MS. Fallback mantido em 7min pra
//              retrocompat (NÃO mudar comportamento sem o Iago trocar no admin manualmente).
function getPixTimeoutMs() {
    try {
        const fromDb = db.getSetting('PIX_TIMEOUT_MS');
        if (fromDb) {
            const n = parseInt(fromDb);
            if (Number.isFinite(n) && n >= 60000) return n; // min 1min pra evitar bug
        }
    } catch(e) {}
    const fromEnv = parseInt(process.env.PIX_TIMEOUT_MS);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 7 * 60 * 1000; // default mantido 7min (retrocompat) — Iago muda no admin pra 5min
}
// ⭐ 12/05: delays opcionais pra primeira msg de funis ABANDONO e APROVADA.
//          Default 0 = INSTANTÂNEO (comportamento atual preservado).
//          Pra ativar, setar no admin/env: ABANDONO_DELAY_MS=150000 (2:30) e APROVADA_DELAY_MS=120000 (2:00)
function getAbandonoDelayMs() {
    try {
        const fromDb = db.getSetting('ABANDONO_DELAY_MS');
        if (fromDb) {
            const n = parseInt(fromDb);
            if (Number.isFinite(n) && n >= 0 && n <= 30*60*1000) return n; // max 30min sanity
        }
    } catch(e) {}
    const fromEnv = parseInt(process.env.ABANDONO_DELAY_MS);
    if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
    return 0; // default INSTANTÂNEO (sem mudança de comportamento)
}
function getAprovadaDelayMs() {
    try {
        const fromDb = db.getSetting('APROVADA_DELAY_MS');
        if (fromDb) {
            const n = parseInt(fromDb);
            if (Number.isFinite(n) && n >= 0 && n <= 30*60*1000) return n;
        }
    } catch(e) {}
    const fromEnv = parseInt(process.env.APROVADA_DELAY_MS);
    if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
    return 0; // default INSTANTÂNEO
}

// ⭐ 15/05: Toggle global do funil de ABANDONO (default LIGADO).
// Quando desligado: webhook de abandono é registrado em events/log mas NÃO cria conversation,
// NÃO dispara notif/push/SSE, NÃO inicia funil. Funis JÁ em andamento continuam normalmente.
function isAbandonoEnabled() {
    try {
        const v = db.getSetting('ABANDONO_ENABLED');
        if (v === '0') return false;
        return true; // default LIGADO (preserva comportamento atual)
    } catch(e) { return true; }
}

// ⭐ 22/07: KILL SWITCH universal do envio automático (default LIGADO).
// Quando desligado: TODO o resto continua (webhooks, eventos, notificações, página PIX,
// lista de Números) — só os FUNIS automáticos não disparam e os em andamento são interrompidos.
// Envio Manual (funnelType MANUAL) NUNCA é bloqueado — é ação deliberada do operador.
function isAutoSendEnabled() {
    try { return db.getSetting('AUTO_SEND_ENABLED', '1') !== '0'; } catch(e) { return true; }
}

// Regras de envio automático POR EVENTO (toggle individual + valor mínimo + só 1ª compra).
// Retorna null se pode enviar, ou o motivo do bloqueio (pra log).
function countPaidEvents(phoneKey) {
    try { return db.getDb().prepare("SELECT COUNT(*) c FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID')").get(phoneKey).c || 0; } catch(e) { return 0; }
}
function autoSendBlockReason(funnelType, amount, phoneKey = null) {
    if (funnelType === 'MANUAL') return null;
    if (!isAutoSendEnabled()) return 'envio automático DESLIGADO no painel';
    const cfgMap = {
        PIX:      { enabled: 'AUTO_SEND_PIX_ENABLED',      min: 'AUTO_SEND_MIN_PIX',      firstOnly: 'AUTO_SEND_FIRST_ONLY_PIX' },
        APROVADA: { enabled: 'AUTO_SEND_APROVADA_ENABLED', min: 'AUTO_SEND_MIN_APROVADA', firstOnly: 'AUTO_SEND_FIRST_ONLY_APROVADA' },
        ABANDONO: { enabled: null /* usa o toggle ABANDONO_ENABLED que já existe */, min: 'AUTO_SEND_MIN_ABANDONO', firstOnly: null }
    };
    const cfg = cfgMap[funnelType];
    if (!cfg) return null; // outros tipos: só o interruptor geral
    if (cfg.enabled && db.getSetting(cfg.enabled, '1') === '0') return `envio de ${funnelType} desligado no painel`;
    const min = parseFloat(db.getSetting(cfg.min, '0')) || 0;
    if (min > 0 && (amount || 0) < min) return `valor R$${(amount || 0).toFixed(2)} abaixo do mínimo R$${min.toFixed(2)}`;
    if (cfg.firstOnly && phoneKey && db.getSetting(cfg.firstOnly, '0') === '1') {
        const paid = countPaidEvents(phoneKey);
        if (funnelType === 'PIX' && paid >= 1) return 'cliente já comprou antes (regra: só 1ª compra)';
        if (funnelType === 'APROVADA' && paid > 1) return 'não é a 1ª compra do cliente (regra: só 1ª compra)';
    }
    // Abandono: máx 1 disparo REAL a cada 24h (conta só funil ENVIADO — abandono barato ignorado não conta)
    if (funnelType === 'ABANDONO' && phoneKey) {
        try {
            const row = db.getDb().prepare("SELECT 1 FROM funnel_receipts WHERE phone_key = ? AND funnel_type = 'ABANDONO' AND datetime(received_at) > datetime('now','-24 hours') LIMIT 1").get(phoneKey);
            if (row) return 'já recebeu mensagem de abandono nas últimas 24h';
        } catch(e) {}
    }
    return null;
}

// Helper: dispara sendStep com delay configurável. Re-checa conv viva antes de enviar.
async function scheduleFirstStep(phoneKey, funnelType) {
    let delayMs = 0;
    if (funnelType === 'ABANDONO') delayMs = getAbandonoDelayMs();
    else if (funnelType === 'APROVADA') delayMs = getAprovadaDelayMs();
    if (delayMs <= 0) {
        await sendStep(phoneKey);
        return;
    }
    addLog('FIRST_STEP_DELAYED', `⏱️ ${funnelType}: aguardando ${Math.round(delayMs/1000)}s antes de enviar 1ª msg`, { phoneKey });
    setTimeout(async () => {
        try {
            // Re-checa: cliente pode ter cancelado/pago/sido bloqueado durante a espera
            const c = conversations.get(phoneKey);
            if (!c || c.canceled || c.completed || c.paused) {
                addLog('FIRST_STEP_SKIP', `⏭️ ${funnelType}: delay expirou mas conv não está viva — pulando envio`, { phoneKey, canceled: c?.canceled, completed: c?.completed, paused: c?.paused });
                return;
            }
            await sendStep(phoneKey);
        } catch(e) {
            console.error('Erro em scheduleFirstStep:', e.message);
        }
    }, delayMs);
}
const PORT = process.env.PORT || 3000;
const MESSAGE_BLOCK_TIME = 60000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_LOGIN = process.env.ADMIN_LOGIN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; // novo: hash bcrypt opcional
const CLEANUP_DAYS = parseInt(process.env.CLEANUP_DAYS || '7');
// ⭐ 20/07 v3.6.2: NOTIFICATION_INSTANCE foi DESATIVADA. Era da época em que notificações saíam
// por um número de WhatsApp pessoal (canal removido em junho — hoje é só push no app). Em produção
// ela estava apontando pra GABY01 e excluía a ÚNICA instância online do pool de envio, silenciosamente.
// A env agora é ignorada (só gera aviso no boot). Instâncias de notificação continuam sendo excluídas
// pelos nomes reservados NOTIFICACAO/NOTIFICACOES ou pela flag is_notification no banco.
const NOTIFICATION_INSTANCE_DEPRECATED = process.env.NOTIFICATION_INSTANCE || '';
if (NOTIFICATION_INSTANCE_DEPRECATED) {
    console.log(`⚠️ NOTIFICATION_INSTANCE="${NOTIFICATION_INSTANCE_DEPRECATED}" está definida mas NÃO é mais usada — variável IGNORADA (a instância volta ao pool de envio). Pode remover do EasyPanel.`);
}
// HMAC secrets pra webhooks (opcionais; se vazios, segue sem verificação como hoje)
const KIRVANO_WEBHOOK_SECRET = process.env.KIRVANO_WEBHOOK_SECRET;
const PERFECTPAY_WEBHOOK_SECRET = process.env.PERFECTPAY_WEBHOOK_SECRET;
// ⭐ FIX 10/05: flag pra exigir HMAC. Quando ligar (=1), webhook SEM signature válida é rejeitado.
// Recomendação: ativar APÓS configurar secrets nos dashboards Kirvano/PerfectPay.
const WEBHOOK_HMAC_REQUIRED = process.env.WEBHOOK_HMAC_REQUIRED === '1';
// LinkRotator integration (opcional — se vazio, não faz relay)
const LINKROTATOR_URL = process.env.LINKROTATOR_URL || '';
const LINKROTATOR_TOKEN = process.env.LINKROTATOR_TOKEN || '';
if (!JWT_SECRET || !ADMIN_LOGIN || (!ADMIN_PASSWORD && !ADMIN_PASSWORD_HASH)) {
  throw new Error("Variáveis de ambiente obrigatórias não definidas!");
}
// ⭐ FIX 10/05: JWT_SECRET fraco = tokens forjáveis em 7d
if (JWT_SECRET.length < 32) {
  throw new Error(`JWT_SECRET muito curto (${JWT_SECRET.length} chars) — mínimo 32. Gere com: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`);
}

// ============ DATABASE ============
const db = require('./database');
db.initDatabase();

// ⭐ 20/07 v3.6.3: migração — o fallback antigo do {PIX_LINK} (e-volutionn.com/planosk) morreu.
// Se o valor antigo estiver salvo nas configurações, troca pelo app de membros automaticamente.
try {
    const oldFb = db.getSetting('PIX_FALLBACK_URL');
    if (oldFb && oldFb.includes('e-volutionn.com')) {
        db.setSetting('PIX_FALLBACK_URL', 'https://m.membrosvips.com');
        console.log('🔧 PIX_FALLBACK_URL migrado: link morto (e-volutionn) → https://m.membrosvips.com');
    }
} catch(e) {}

// ROLLBACK SEGURO: restaura conversas ativas (PIX pendente + funil em andamento) do banco para memória
function restorePendingConversations() {
    try {
        const rows = db.getDb().prepare(`
            SELECT * FROM conversations
            WHERE canceled=0 AND completed=0
              AND datetime(created_at) > datetime('now','-3 days')
        `).all();
        let restored = 0;
        for (const row of rows) {
            const conv = {
                phoneKey: row.phone_key,
                remoteJid: row.remote_jid,
                funnelId: row.funnel_id,
                stepIndex: row.step_index,
                orderCode: row.order_code,
                customerName: row.customer_name,
                customerEmail: row.customer_email,
                productId: row.product_id,
                productName: row.product_name,
                orderBumps: (() => { try { return JSON.parse(row.order_bumps || '[]'); } catch(e) { return []; } })(),
                amount: row.amount || 0,
                amountDisplay: row.amount_display,
                netValue: row.net_value || 0,
                pixCode: row.pix_code,
                checkoutUrl: row.checkout_url, // ⭐ FIX 04/05: faltava restaurar — depois de restart, {PIX_LINK} caía pro fallback do código pix
                paymentMethod: row.payment_method || 'PIX',
                ddd: row.ddd, city: row.city, state: row.state,
                waiting_for_response: !!row.waiting_for_response,
                pixWaiting: !!row.pix_waiting,
                canceled: false, completed: false,
                hasError: !!row.has_error,
                invalidNumber: !!row.invalid_number,
                transferredFromPix: !!row.transferred_from_pix,
                paused: !!row.paused,
                reactivation: !!row.reactivation,
                abFunnelVariant: row.ab_funnel_variant,
                createdAt: row.created_at ? new Date(row.created_at) : new Date(),
                lastMessageAt: row.last_message_at ? new Date(row.last_message_at) : null,
                lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at) : null,
                // ⭐ FIX 04/05: restaura flags em memória que viviam só no Map antes
                awaitingPool: !!row.awaiting_pool,
                waitingForStickyReturn: !!row.waiting_for_sticky_return,
                funnelType: row.funnel_type,
                lastSendError: row.last_send_error,
                lastSystemMessage: row.last_message_at ? new Date(row.last_message_at) : null
            };
            conversations.set(row.phone_key, conv);
            restored++;
        }
        if (restored > 0) console.log(`💾 Conversas restauradas: ${restored} em andamento recuperadas do banco`);
    } catch(e) { console.log('Restore conversations erro:', e.message); }
}

// ROLLBACK SEGURO: restaura timers PIX pendentes após restart do servidor
function restorePendingPixTimeouts() {
    try {
        db.cleanExpiredPixTimeouts();
        const rows = db.getAllPendingPixTimeouts();
        let restored = 0, fired = 0;
        const now = Date.now();
        for (const row of rows) {
            const fireAt = new Date(row.fire_at).getTime();
            const remaining = fireAt - now;
            const phoneKey = row.phone_key;
            const orderCode = row.order_code;

            // Recupera conversa do banco (conversations Map é reconstruído via outros meios, mas o timer em si precisa voltar)
            const conv = conversations.get(phoneKey);

            if (remaining <= 0) {
                // Timer já deveria ter disparado — dispara agora
                (async () => {
                    try {
                        const c = conversations.get(phoneKey);
                        if (c && c.orderCode === orderCode && !c.canceled && c.pixWaiting) {
                            c.pixWaiting = false; c.stepIndex = 0;
                            const selectedFunnel = selectABFunnel(c.productId, 'PIX');
                            c.funnelId = selectedFunnel; c.abFunnelVariant = selectedFunnel;
                            conversations.set(phoneKey, c);
                            db.recordABResult(selectedFunnel, false);
                            db.recordFunnelReceipt(phoneKey, c.productId, 'PIX', selectedFunnel);
                            await sendStep(phoneKey);
                        }
                        pixTimeouts.delete(phoneKey);
                        db.deletePixTimeout(phoneKey);
                    } catch(e) { console.error('Erro ao disparar timer restaurado:', e.message); }
                })();
                fired++;
            } else {
                // Reagenda com tempo restante
                const timeout = setTimeout(async () => {
                    try {
                        const c = conversations.get(phoneKey);
                        if (c && c.orderCode === orderCode && !c.canceled && c.pixWaiting) {
                            c.pixWaiting = false; c.stepIndex = 0;
                            const selectedFunnel = selectABFunnel(c.productId, 'PIX');
                            c.funnelId = selectedFunnel; c.abFunnelVariant = selectedFunnel;
                            conversations.set(phoneKey, c);
                            db.recordABResult(selectedFunnel, false);
                            db.recordFunnelReceipt(phoneKey, c.productId, 'PIX', selectedFunnel);
                            await sendStep(phoneKey);
                        }
                        pixTimeouts.delete(phoneKey);
                        db.deletePixTimeout(phoneKey);
                    } catch(e) { console.error('Erro ao disparar timer reagendado:', e.message); }
                }, remaining);
                pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
                restored++;
            }
        }
        if (restored > 0 || fired > 0) {
            console.log(`⏱️  Timers PIX restaurados: ${restored} reagendados, ${fired} disparados imediatamente`);
        }
    } catch(e) { console.log('Restore PIX timers erro:', e.message); }
}
// ============ ESTADO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let phoneVariations = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let messageBlockTimers = new Map();
let sseClients = [];

// A/B: índice atual por produto
let abIndexMap = new Map();

// ============ SSE ============
function sendSSE(event, data) {
    // Auto-enrich: marca isFemale e highValue pro app destacar leads que precisam de ação rápida.
    // isFemale: público é homem → mulher = lead errado.
    // highValue: PIX/venda acima do threshold (default R$50) → priorizar visualmente.
    if (data && typeof data === 'object') {
        try {
            const enriched = { ...data };
            if (data.customerName && data.isFemale === undefined) {
                enriched.isFemale = detectFemaleName(data.customerName);
            }
            if (data.netValue != null && data.highValue === undefined && !enriched.isFemale) {
                const nv = parseFloat(data.netValue);
                if (Number.isFinite(nv)) enriched.highValue = nv >= getHighValueThreshold();
            }
            data = enriched;
        } catch(e) {}
    }
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients = sseClients.filter(res => { try { res.write(msg); return true; } catch { return false; } });
}

// ============ NOTIFICAÇÕES ============
// Preferências de notificação — controláveis pelo app (system_settings, default ligado).
// Mapeia o tipo do push para a chave de preferência correspondente.
const PUSH_PREF_KEYS = {
    pix_generated: 'notif_pix_generated',
    payment: 'notif_payment',
    card: 'notif_payment',
    cart_abandoned: 'notif_cart_abandoned',
    card_refused: 'notif_card_refused',
    refund: 'notif_refund',
    daily_summary: 'notif_daily_summary',
    morning_summary: 'notif_morning_summary',
    info: 'notif_system'
};
function isPushEnabled(type) {
    const key = PUSH_PREF_KEYS[type];
    if (!key) return true; // tipos sem preferência (ex: info) sempre passam
    try { return db.getSetting(key, '1') !== '0'; } catch(e) { return true; }
}

// Envia push para o celular
async function sendPushNotification(title, body, type = 'info', extras = {}) {
    if (!webpush || pushSubscriptions.size === 0) return;
    if (!isPushEnabled(type)) return;
    const payload = JSON.stringify({
        title,
        body,
        type,
        tag: type,
        url: '/mobile.html',
        timestamp: Date.now(),
        // ⭐ 12/05: extras transparentes (isFemale, highValue) — SW usa pra colorir notificação
        isFemale: !!extras.isFemale,
        highValue: !!extras.highValue
    });
    const toDelete = [];
    for (const [id, sub] of pushSubscriptions.entries()) {
        try {
            await webpush.sendNotification(sub, payload);
        } catch(e) {
            if (e.statusCode === 410 || e.statusCode === 404) {
                toDelete.push(id);
            }
        }
    }
    // Remove assinaturas expiradas
    for (const id of toDelete) pushSubscriptions.delete(id);
    // Persiste assinaturas no banco
    try {
        db.getDb().prepare("DELETE FROM push_subscriptions WHERE sub_id IN (" + toDelete.map(()=>'?').join(',') + ")").run(...toDelete);
    } catch(e) {}
}

// Resumos do dia via push — manhã (9h, como o dia começou) e fechamento (23:59, financeiro completo).
// Canal WhatsApp de notificações foi removido: todo aviso ao operador sai apenas como push do app.
function formatCurrency(val) { return 'R$ ' + (val || 0).toFixed(2).replace('.', ','); }

async function sendDailySummaryPush(period) {
    const today = db.getTodayStats(todayBR());
    const convRate = today.pix_generated > 0 ? ((today.pix_paid + today.card_paid) / today.pix_generated * 100).toFixed(1) : '0.0';
    const totalSales = (today.pix_paid || 0) + (today.card_paid || 0);
    const fmt = v => 'R$ ' + Math.round(v || 0).toLocaleString('pt-BR');

    try {
        const finance = db.getFinanceDay(todayBR());
        const netRev = parseFloat(finance.net) || 0;

        if (period === 'morning') {
            const title = `Bom dia · ${totalSales} vendas · ${fmt(netRev)}`;
            const body = `PIX gerados ${today.pix_generated} · Conversão ${convRate}%`;
            await sendPushNotification(title, body, 'morning_summary');
        } else {
            const title = `Fechamento · ${totalSales} vendas · ${fmt(netRev)}`;
            const body = `Faturou ${fmt(netRev)} · ${totalSales} vendas · Conversão ${convRate}%`;
            await sendPushNotification(title, body, 'daily_summary');
        }
    } catch(e) { /* não pode bloquear cron */ }
}

function scheduleReports() {
    setInterval(async () => {
        const now = new Date();
        const h = now.getHours();
        const m = now.getMinutes();
        if (h === 9 && m === 0) await sendDailySummaryPush('morning');
        if (h === 23 && m === 59) await sendDailySummaryPush('night');
    }, 60000);
}

scheduleReports();

// ============ VARIÁVEIS DINÂMICAS ============
function getSaudacao() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return 'bom dia';
    if (h >= 12 && h < 18) return 'boa tarde';
    return 'boa noite';
}

function formatName(fullName) {
    if (!fullName) return '';
    const first = fullName.trim().split(/\s+/)[0];
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// Data de hoje no fuso de Brasília (YYYY-MM-DD)
function todayBR() {
    const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
    return now.toISOString().split('T')[0];
}

// ============ MAPPING DE NOMES DE PRODUTOS (display amigável) ============
// Pra mostrar nomes bonitos no resumo do pedido da página /pix/:token
// quando o nome cadastrado na Kirvano não pode ser editado.
// Adicione aqui mapeamentos novos: 'NOME_KIRVANO': 'NOME_BONITO'
const PRODUCT_DISPLAY_NAMES = {
    'ASS VIP CH': 'CHAMADINHA DE VÍDEO',
    'VIP 24 HORAS': 'GRUPINHO VIP 24 HORAS',
    // Adicione novos aqui conforme necessário
};
function mapProductName(originalName) {
    if (!originalName) return '';
    const upper = String(originalName).trim().toUpperCase();
    return PRODUCT_DISPLAY_NAMES[upper] || originalName;
}

// Extrai e ordena produtos do payload Kirvano (principal primeiro, bumps depois)
function extractProductsForSummary(rawProducts) {
    if (!Array.isArray(rawProducts) || rawProducts.length === 0) return [];
    const list = rawProducts.map(p => {
        const priceRaw = String(p.price || '').replace(/[^0-9,.-]/g, '').replace(/\./g, '').replace(',', '.');
        const price = parseFloat(priceRaw) || 0;
        return {
            name: mapProductName(p.name || p.offer_name),
            price,
            is_bump: !!p.is_order_bump
        };
    });
    // Principal primeiro, bumps depois (preserva ordem original dentro de cada grupo)
    return [...list.filter(p => !p.is_bump), ...list.filter(p => p.is_bump)];
}

// Formata valor em BRL (ex: R$ 27,55)
function formatBRL(val) {
    return 'R$ ' + (val || 0).toFixed(2).replace('.', ',');
}

// Limites das estrelas configuráveis via settings (líquido em R$)
function getStarTiers() {
    return {
        t1: parseFloat(db.getSetting('star_tier_1', '30')) || 30,
        t2: parseFloat(db.getSetting('star_tier_2', '60')) || 60,
        t3: parseFloat(db.getSetting('star_tier_3', '100')) || 100
    };
}

// Retorna prefixo de estrelas conforme valor líquido
function getStarPrefix(netValue) {
    const t = getStarTiers();
    if (netValue >= t.t3) return '⭐⭐⭐ ';
    if (netValue >= t.t2) return '⭐⭐ ';
    if (netValue >= t.t1) return '⭐ ';
    return '';
}

// ============ DETECÇÃO DE GÊNERO POR NOME (FILTRO FEMININO) ============
// Público da Orion é masculino. Lead feminino = lead errado → operador quer ver visualmente
// e ser avisado na notificação push pra agir rápido (bloquear / cancelar envio).
//
// Lista curada com top ~280 nomes femininos brasileiros (ranking IBGE + variações comuns).
// Estratégia conservadora: só marca como feminino se NOME EXATO casar com o dicionário.
// Sem heurística de sufixo "termina em A" — evita falso-positivo masculino (André, Joaquim, etc).
const FEMALE_NAMES_BR = new Set([
    'maria','ana','francisca','antonia','antônia','adriana','juliana','marcia','márcia','fernanda',
    'patricia','patrícia','aline','sandra','camila','amanda','bruna','jessica','jéssica','leticia',
    'letícia','julia','júlia','luciana','vanessa','mariana','gabriela','valeria','valéria','carolina',
    'beatriz','joana','vitoria','vitória','isabela','isabella','larissa','marina','rafaela','daniela',
    'bianca','debora','débora','eliane','eliana','rosana','simone','sonia','sônia','claudia','cláudia',
    'marta','ines','inês','alessandra','andrea','andréa','regina','rita','monica','mônica','rosa',
    'lucia','lúcia','helena','paula','carla','cintia','cíntia','cynthia','raquel','renata','viviane',
    'viviana','tatiana','priscila','priscilla','michele','michelle','eduarda','isadora','manuela',
    'manoela','sabrina','sheila','silvana','silvia','sílvia','vania','vânia','milena','nadia','nádia',
    'natalia','natália','natalie','natalia','neusa','neuza','olivia','olívia','sarah','sara','stella',
    'tania','tânia','telma','thelma','yara','iara','zenaide','alice','aurora','agatha','agata','ágata',
    'valentina','alana','alexandra','alyne','aline','angela','ângela','angélica','angelica','bárbara',
    'barbara','bia','caroline','cassia','cássia','celia','célia','cristina','cristiane','denise',
    'dora','edna','elenice','elen','ellen','elaine','elis','elisa','elisabete','elisabeth','elizabete',
    'eloa','eloah','emanuelle','emanuela','emilly','emily','esther','ester','eveline','evelyn','evelin',
    'fátima','fatima','flavia','flávia','gabriele','gabrielly','geni','geralda','glaucia','gláucia',
    'gilda','gisela','gisele','gleice','graziela','graziele','heloisa','heloísa','iris','íris','isabel',
    'ivete','ivone','jacira','jaqueline','jacqueline','joelma','karen','karina','karoline','katia',
    'kátia','kelly','kely','laís','lais','lara','laura','lavinia','lavínia','layla','leila','lidia',
    'lídia','lina','livia','lívia','lorena','lourdes','luana','lucineia','lucinéia','luiza','luísa',
    'luisa','luna','madalena','magda','manuella','marcela','marcia','marília','marilia','marisa',
    'marlene','mary','melissa','mirella','mirian','miriam','nayara','nelma','nilza','noemi','olga',
    'paloma','penha','poliana','rejane','rosalia','rosália','rosangela','rosângela','roseli','rute',
    'ruth','samantha','samara','sebastiana','selma','sirlene','solange','sophia','sofia','soraia',
    'sueli','taina','tainá','tamara','tamires','tatiane','teresa','therezinha','teresinha','vera',
    'walquiria','wanderleia','zelia','zélia','zilda','dayane','daiane','daniella','diana','catarina',
    'leonora','irene','iris','marli','marly','sirley','michelly','heloísa','bruninha','aparecida',
    'conceicao','conceição','divina','perpetua','perpétua','rosario','rosário','salete','clarice',
    'estela','estrela','dirce','dilma','julieta','clarissa','glória','gloria','dominique','tabata',
    'tábata','larissia','isabelly','rebeca','rebecca','clara','marivalda','vanusa','dayse','dayse',
    'denilda','adelina','adelaide','luana','geovana','giovana','giulia','giullia','katia','katya'
]);

function _normalizeName(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function detectFemaleName(fullName) {
    if (!fullName) return false;
    const first = _normalizeName(fullName).split(/\s+/)[0];
    if (!first || first.length < 2) return false;
    return FEMALE_NAMES_BR.has(first);
}

// ============ LINK ROTATOR RELAY (fire-and-forget) ============
// Repassa eventos PIX_GENERATED e SALE_APPROVED pro LinkRotator pra atribuição por typebot.
// Não bloqueia o webhook Kirvano — falha silenciosa, só loga.
async function relayToLinkRotator(eventType, payload) {
    if (!LINKROTATOR_URL || !LINKROTATOR_TOKEN) return; // integração desativada
    try {
        const url = `${LINKROTATOR_URL.replace(/\/$/, '')}/api/webhook/orion?token=${encodeURIComponent(LINKROTATOR_TOKEN)}`;
        const body = {
            event: eventType,
            ref: payload.ref || payload.utm_content || null,
            sale_id: payload.sale_id || payload.order_code || null,
            order_code: payload.order_code || payload.sale_id || null,
            customer_phone: payload.customer_phone || null,
            customer_name: payload.customer_name || null,
            customer_email: payload.customer_email || null,
            amount_gross: payload.amount_gross || 0,
            amount_net: payload.amount_net || 0,
            product_name: payload.product_name || null,
            payment_method: payload.payment_method || null,
            utm_source: payload.utm_source || null,
            utm_campaign: payload.utm_campaign || null
        };
        // Fire-and-forget com timeout curto + retry simples (3 tentativas com backoff)
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const r = await axios.post(url, body, { timeout: 5000, headers: { 'Content-Type': 'application/json' } });
                addLog('LR_RELAY', `→ LinkRotator ${eventType} OK (sale ${body.sale_id})`);
                return r.data;
            } catch (e) {
                lastErr = e;
                if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 500));
            }
        }
        addLog('LR_RELAY_ERR', `LinkRotator falhou após 3 tentativas: ${lastErr?.message || 'unknown'}`, { saleId: body.sale_id });
    } catch (e) { /* nunca deve quebrar webhook principal */ }
}

// Constrói notificação padronizada (push + WhatsApp)
// type: 'pix_generated' | 'pix_paid' | 'card_paid' | 'cart_abandoned'
// ⭐ FIX 10/05: emojis MUITO distintos no início do título (1ª coisa visível no iPhone web push)
//   ⏳ PIX gerado · 💰 PIX pago · 💳 Cartão pago · 🛒 Carrinho abandonado
// Threshold de "PIX alto valor" — editável via settings (default R$50)
function getHighValueThreshold() {
    return parseFloat(db.getSetting('high_value_threshold', '50')) || 50;
}

function buildPaymentNotification(type, customerName, netValue, productName = null) {
    const valor = formatBRL(netValue);
    const nome = formatName(customerName) || 'Cliente';
    // Detecção mantida apenas para diferenciar vibração/som no service worker.
    // Não aparece no texto da notificação (mantém o visual simples, sem emojis).
    const isFemale = detectFemaleName(customerName);
    const isHighValue = !isFemale && netValue >= getHighValueThreshold();

    let title, pushType;
    if (type === 'pix_generated') {
        title = `PIX Gerado · ${valor}`;
        pushType = 'pix_generated';
    } else if (type === 'pix_paid') {
        title = `PIX Pago · ${valor}`;
        pushType = 'payment';
    } else if (type === 'card_paid') {
        title = `Cartão Pago · ${valor}`;
        pushType = 'card';
    } else if (type === 'cart_abandoned') {
        title = `Carrinho Abandonado · ${valor}`;
        pushType = 'cart_abandoned';
    } else if (type === 'card_refused') {
        title = `Cartão Recusado · ${valor}`;
        pushType = 'card_refused';
    } else if (type === 'payment_refused') {
        // Recusa em métodos que não são cartão (PayPal, boleto etc.) — mesma preferência do recusado
        title = `Pagamento Recusado · ${valor}`;
        pushType = 'card_refused';
    } else if (type === 'refund') {
        title = `Reembolso · ${valor}`;
        pushType = 'refund';
    } else {
        // fallback (compatibilidade com chamadas antigas)
        title = `Venda Aprovada · ${valor}`;
        pushType = 'payment';
    }

    // Corpo em linha única: "Produto · Nome" (produto longo é cortado pra não quebrar em 2 linhas)
    let produto = productName ? String(productName).trim() : '';
    if (produto.length > 32) produto = produto.slice(0, 31).trimEnd() + '…';
    const body = produto ? `${produto} · ${nome}` : nome;

    return {
        title,
        body,
        pushType,
        // Reembolso/recusa não usam vibração comemorativa
        isFemale: (type === 'refund') ? false : isFemale,
        highValue: (type === 'refund' || type === 'card_refused' || type === 'payment_refused') ? false : isHighValue
    };
}

function replaceVariables(text, conversation) {
    if (!text || !conversation) return text;
    let r = text;
    // ⭐ FIX 04/05: substitui SEMPRE (com fallback vazio). Antes, variáveis com valor null/undefined
    // ficavam literais na mensagem (ex: "Olá {NOME_CLIENTE}, você está em {CIDADE}" virava "Olá {NOME_CLIENTE}, você está em {CIDADE}").
    // Também usa callback (() => valor) pra evitar bug de String.replace interpretar $/\1 como backreference em nomes.
    const safe = (v) => v == null ? '' : String(v);
    const nomeFormatado = conversation.customerName ? formatName(conversation.customerName) : '';
    // ⭐ FIX 10/05: {PIX_LINK} NUNCA pode sair vazio.
    // Prioridade: 1) checkoutUrl (página /pix/:token gerada pro cliente)
    //             2) PIX_FALLBACK_URL (configurável no admin)
    //             3) default hardcoded (último recurso)
    // ATENÇÃO: NÃO usar pixCode aqui — é o EMV/base64 cru, não é link clicável e enche a msg.
    let linkPix = conversation.checkoutUrl;
    if (!linkPix) {
        try {
            // ⭐ 20/07 v3.6.3: fallback antigo (e-volutionn.com/planosk) MORREU — agora é o app de membros
            const fb = db.getSetting('PIX_FALLBACK_URL', 'https://m.membrosvips.com');
            linkPix = (fb && String(fb).trim()) || 'https://m.membrosvips.com';
            addLog('PIX_LINK_FALLBACK', `🟠 Link cliente indisponível — caindo no fallback (${linkPix})`, { phoneKey: conversation.phoneKey, orderCode: conversation.orderCode });
        } catch(e) {
            linkPix = 'https://m.membrosvips.com';
        }
    }
    r = r.replace(/\{PIX_LINK\}/g, () => linkPix);
    r = r.replace(/\{PIX_GERADO\}/g, () => safe(conversation.pixCode));
    r = r.replace(/\{PIX_CODE\}/g, () => safe(conversation.pixCode));
    r = r.replace(/\{NOME_CLIENTE\}/g, () => nomeFormatado);
    r = r.replace(/\{NOME\}/g, () => nomeFormatado);
    r = r.replace(/\{VALOR\}/g, () => safe(conversation.amountDisplay));
    r = r.replace(/\{PRODUTO\}/g, () => safe(conversation.productName));
    // ⭐ 20/07 v3.6.3: sem cidade identificada → "onde" (a frase "você é de {CIDADE}?" vira "você é de onde?")
    r = r.replace(/\{CIDADE\}/g, () => safe(conversation.city) || 'onde');
    r = r.replace(/\{ESTADO\}/g, () => safe(conversation.state));
    r = r.replace(/\{ORDER_BUMPS\}/g, () => Array.isArray(conversation.orderBumps) ? conversation.orderBumps.join(', ') : '');
    r = r.replace(/\{SAUDACAO\}/g, () => getSaudacao());
    // ⭐ 20/07: e-mail do cliente (login do app de membros) — pra mandar o acesso já com o login na msg
    r = r.replace(/\{EMAIL\}/g, () => safe(conversation.customerEmail));
    r = r.replace(/\{EMAIL_CLIENTE\}/g, () => safe(conversation.customerEmail));
    return r;
}

// ============ A/B TEST / SELEÇÃO DE FUNIL ============
// ⭐ FIX 07/26: agora escolhe SEMPRE um funil que EXISTE e TEM passos, mesmo que o id não siga
// a convenção "PRODUTO_TIPO". Antes o sistema assumia que o funil se chamava exatamente
// GRUPO_VIP_ABANDONO; se o usuário tinha o funil de abandono com outro nome (ou o
// GRUPO_VIP_ABANDONO existia vazio como rascunho), caía em "funil vazio" e não enviava.
// Estratégia: junta o padrão + variantes A/B do produto + QUALQUER funil do produto com o
// tipo certo; descarta os vazios; faz round-robin só entre os que têm conteúdo.
function selectABFunnel(productId, funnelType) {
    const defaultFunnel = productId + '_' + funnelType;
    const candidateIds = new Set([defaultFunnel]);

    // Variantes A/B configuradas no produto
    const product = db.getProducts().find(p => p.id === productId);
    if (product) {
        try { JSON.parse(product.ab_funnel_ids || '[]').forEach(id => candidateIds.add(id)); } catch {}
    }
    // Qualquer funil do produto (ou com id no padrão PRODUTO_*) cujo tipo bata com o pedido
    try {
        db.getFunnels().forEach(f => {
            const belongsToProduct = f.product_id === productId || (f.id || '').startsWith(productId + '_');
            const typeMatches = f.type === funnelType || (f.id || '').toUpperCase().includes(funnelType);
            if (belongsToProduct && typeMatches) candidateIds.add(f.id);
        });
    } catch {}

    // Mantém só os que existem E têm passos (ignora rascunhos/stubs vazios)
    const pool = [...candidateIds].filter(id => {
        const f = db.getFunnelById(id);
        return f && Array.isArray(f.steps) && f.steps.length > 0;
    });

    if (pool.length === 0) {
        // ⭐ 29/07: FUNIL GLOBAL — sem funil específico do produto, cai no funil GLOBAL_<TIPO>
        // (um funil só que vale pra TODOS os produtos — assinatura, GRUPO VIP, ZAP VIP...)
        const globalPool = db.getFunnels().filter(f =>
            (f.product_id === 'GLOBAL' || (f.id || '').startsWith('GLOBAL_')) &&
            (f.type === funnelType || (f.id || '').toUpperCase().includes(funnelType)) &&
            Array.isArray(f.steps) && f.steps.length > 0
        );
        if (globalPool.length > 0) {
            const gKey = 'GLOBAL_' + funnelType;
            const gIdx = abIndexMap.get(gKey) || 0;
            const chosen = globalPool[gIdx % globalPool.length].id;
            abIndexMap.set(gKey, gIdx + 1);
            addLog('FUNNEL_GLOBAL', `🌐 ${funnelType} → funil GLOBAL ${chosen} (produto ${productId} sem funil próprio)`, { productId, funnelType });
            return chosen;
        }
        // Nenhum funil com conteúdo — retorna o padrão (dispara o alerta de "funil vazio" no sendStep)
        addLog('AB_NO_CONTENT', `⚠️ Nenhum funil de ${funnelType} com passos para ${productId} — usando ${defaultFunnel}`, { productId, funnelType });
        return defaultFunnel;
    }

    // Preferência: se o funil padrão (convenção) tem conteúdo, ele lidera o pool
    pool.sort((a, b) => (a === defaultFunnel ? -1 : b === defaultFunnel ? 1 : 0));

    const key = productId + '_' + funnelType;
    const currentIdx = abIndexMap.get(key) || 0;
    const selectedFunnel = pool[currentIdx % pool.length];
    abIndexMap.set(key, currentIdx + 1);

    if (pool.length > 1) addLog('AB_SELECT', `🔄 A/B: ${selectedFunnel} (${(currentIdx % pool.length) + 1}/${pool.length})`, { productId, funnelType });
    else if (selectedFunnel !== defaultFunnel) addLog('FUNNEL_RESOLVED', `✅ ${funnelType} → ${selectedFunnel} (funil real, id fora da convenção)`, { productId, funnelType });
    return selectedFunnel;
}

// ============ GATILHOS ============
function normStr(str) { return String(str).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').trim(); }

// \u2b50 FIX 04/05: match por palavra inteira (evita "obrigado pela aten\u00e7\u00e3o" disparar trigger "oi")
function containsWord(text, kw) {
    if (!kw) return false;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(text);
}

function similarityScore(a, b) {
    if (a === b) return 1;
    if (Math.abs(a.length - b.length) > 3) return 0;
    let matches = 0;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    for (let i = 0; i < shorter.length; i++) {
        if (longer.includes(shorter[i])) matches++;
    }
    return matches / longer.length;
}

function checkTriggers(text, conversation) {
    const triggers = db.getTriggers();
    if (!triggers.length) return null;
    const normText = normStr(text);

    for (const trigger of triggers) {
        const keywords = trigger.keywords.split(';').map(k => normStr(k.trim())).filter(Boolean);

        for (const kw of keywords) {
            let matched = false;

            if (trigger.match_type === 'exact') {
                matched = normText === kw;
            } else if (trigger.match_type === 'contains') {
                // ⭐ FIX 04/05: word boundary — "oi" não casa em "obrigado", "ola pessoal"
                matched = containsWord(normText, kw);
            } else if (trigger.match_type === 'similar') {
                matched = containsWord(normText, kw) || keywords.some(k => normText.split(' ').some(word => similarityScore(word, k) >= 0.75));
            }

            if (matched) {
                addLog('TRIGGER_MATCH', `🎯 Gatilho "${trigger.name}" ativado (${trigger.match_type})`, { keyword: kw, text: text.substring(0, 50) });
                return trigger;
            }
        }
    }
    return null;
}

// ============ START TRIGGERS (gatilhos para INICIAR funil em lead novo) ============
// Verifica se a mensagem de um lead novo bate com algum gatilho de início.
// Retorna o trigger encontrado ou null.
// Filtra também por instância: se o trigger restringe instâncias e a atual não está na lista, ignora.
// ⭐ FIX 10/05: parâmetro `debug=true` retorna {trigger, reasons[]} pra diagnóstico via endpoint de teste.
function checkStartTriggers(text, instanceName, debug = false) {
    const reasons = []; // só populado se debug=true
    try {
        const triggers = db.getActiveStartTriggers();
        if (!triggers || !triggers.length) {
            const r = 'Nenhum start_trigger ATIVO no banco (active=1)';
            if (debug) reasons.push(r);
            else addLog('START_TRIGGER_DEBUG', `❌ ${r}`);
            return debug ? { trigger: null, reasons, normalizedText: normStr(text || '') } : null;
        }
        const normText = normStr(text || '');
        if (!normText) {
            const r = `Texto vazio após normalização (original: "${(text||'').substring(0,40)}") — provavelmente áudio/imagem/sticker`;
            if (debug) reasons.push(r);
            else addLog('START_TRIGGER_DEBUG', `❌ ${r}`);
            return debug ? { trigger: null, reasons, normalizedText: '' } : null;
        }

        for (const trigger of triggers) {
            const tName = trigger.name || `id=${trigger.id}`;

            // Filtro por instância
            let allowedInstances = [];
            try { allowedInstances = JSON.parse(trigger.instances || '[]'); } catch(e) { allowedInstances = []; }
            // ⭐ 29/07: canal oficial é único — filtro de instância (era Evolution) não se aplica
            if (instanceName !== 'oficial' && allowedInstances.length > 0 && instanceName && !allowedInstances.includes(instanceName)) {
                const r = `[${tName}] PULADO — instância "${instanceName}" não está em [${allowedInstances.join(', ')}]`;
                if (debug) reasons.push(r);
                continue;
            }

            const keywords = String(trigger.keywords || '').split(';').map(k => normStr(k.trim())).filter(Boolean);
            if (!keywords.length) {
                const r = `[${tName}] PULADO — sem keywords cadastradas`;
                if (debug) reasons.push(r);
                continue;
            }

            let matchedKw = null;
            for (const kw of keywords) {
                let matched = false;

                if (trigger.match_type === 'exact') {
                    matched = normText === kw;
                } else if (trigger.match_type === 'contains') {
                    matched = containsWord(normText, kw); // ⭐ FIX 04/05: word boundary
                } else if (trigger.match_type === 'similar') {
                    matched = containsWord(normText, kw) || normText.split(' ').some(word => similarityScore(word, kw) >= 0.75);
                } else {
                    matched = containsWord(normText, kw); // default: contains com word boundary
                }

                if (matched) { matchedKw = kw; break; }
            }

            if (matchedKw) {
                addLog('START_TRIGGER_MATCH', `🚀 Gatilho de início "${tName}" ativado`, { keyword: matchedKw, text: text.substring(0, 50), instance: instanceName });
                if (debug) reasons.push(`[${tName}] ✅ MATCH (keyword "${matchedKw}", match_type=${trigger.match_type||'contains'})`);
                return debug ? { trigger, reasons, normalizedText: normText } : trigger;
            } else {
                const r = `[${tName}] NÃO BATEU — texto normalizado "${normText.substring(0,80)}" vs keywords [${keywords.join(' | ')}] (match_type=${trigger.match_type||'contains'})`;
                if (debug) reasons.push(r);
            }
        }

        // Não achou nenhum match — loga só se NÃO for debug (debug devolve via response)
        if (!debug) addLog('START_TRIGGER_DEBUG', `🔍 Mensagem "${text.substring(0,50)}" não bateu com nenhum trigger ativo (instância ${instanceName})`);
        return debug ? { trigger: null, reasons, normalizedText: normText } : null;
    } catch(e) {
        addLog('START_TRIGGER_ERR', `Erro em checkStartTriggers: ${e.message}`);
        return debug ? { trigger: null, reasons: ['ERRO: ' + e.message], normalizedText: '' } : null;
    }
}

// Cria conversa nova a partir de um start_trigger e dispara o primeiro passo.
async function startConversationFromTrigger(trigger, phoneKey, remoteJid, location, incomingInstance, pushName = null) {
    try {
        // Resolve produto
        let productId = trigger.target_product_id;
        let productName = '';
        if (productId) {
            const prod = db.getProducts().find(p => p.id === productId);
            if (prod) productName = prod.name;
        }
        // Se não tem produto, tenta extrair do funil
        if (!productId) {
            const f = db.getFunnelById(trigger.target_funnel_id);
            if (f) {
                productId = f.product_id;
                const prod = db.getProducts().find(p => p.id === productId);
                if (prod) productName = prod.name;
            }
        }
        if (!productId) {
            addLog('START_TRIGGER_NO_PRODUCT', `⚠️ Trigger "${trigger.name}" sem produto resolvido`);
            return false;
        }

        const orderCode = 'TRIGGER_' + Date.now();
        const conv = {
            phoneKey, remoteJid,
            funnelId: trigger.target_funnel_id, stepIndex: 0,
            orderCode,
            // ⭐ 20/07: usa o nome do perfil do WhatsApp (pushName) quando disponível — {NOME} personalizado
            customerName: (pushName && String(pushName).trim()) || 'Cliente',
            productId, productName,
            orderBumps: [], amount: 0, amountDisplay: 'R$ 0,00', netValue: 0,
            paymentMethod: 'PIX',
            ddd: location?.ddd, city: location?.city, state: location?.state,
            waiting_for_response: false,
            createdAt: new Date(),
            canceled: false, completed: false, paused: false,
            funnelType: 'DIRETO',
            startTriggerId: trigger.id
        };
        conversations.set(phoneKey, conv);
        registerPhoneUniversal(remoteJid, phoneKey);
        try { convToDb(phoneKey, conv); } catch(e) {} // ⭐ 20/07: persiste na hora (antes só no tick de 15s — deploy no meio perdia a conversa)
        db.incrementStartTriggerCount(trigger.id);
        // ⭐ FIX 11/05: registra log do disparo pra dashboard de stats
        try {
            db.logStartTriggerFire({
                trigger_id: trigger.id,
                trigger_name: trigger.name,
                phone_key: phoneKey,
                matched_keyword: trigger.keywords,
                instance: incomingInstance,
                target_funnel_id: trigger.target_funnel_id
            });
        } catch(e) {}

        addLog('START_TRIGGER_FUNNEL', `🚀 Iniciando funil "${trigger.target_funnel_id}" via trigger "${trigger.name}"`, { phoneKey });
        await sendStep(phoneKey);
        return true;
    } catch(e) {
        addLog('START_TRIGGER_FUNNEL_ERR', `Erro ao iniciar funil: ${e.message}`);
        return false;
    }
}

// ============ ANTI-DUPLICAÇÃO ============
function generateMessageHash(phoneKey, step, conversation) {
    return crypto.createHash('md5').update(`${phoneKey}|${step.type}|${step.text || step.mediaUrl || ''}|${step.id}`).digest('hex');
}
function isMessageBlocked(phoneKey, step, conversation) {
    const hash = generateMessageHash(phoneKey, step, conversation);
    const last = messageBlockTimers.get(hash);
    if (last && (Date.now() - last) < MESSAGE_BLOCK_TIME) return true;
    return false;
}
function registerSentMessage(phoneKey, step, conversation) {
    const hash = generateMessageHash(phoneKey, step, conversation);
    messageBlockTimers.set(hash, Date.now());
}
setInterval(() => {
    const now = Date.now();
    for (const [h, ts] of messageBlockTimers.entries()) if (now - ts > MESSAGE_BLOCK_TIME) messageBlockTimers.delete(h);
}, 120000);

// ============ NORMALIZAÇÃO DE TELEFONE ============
function normalizePhoneKey(phone) {
    if (!phone) return null;
    const cleaned = String(phone).split('@')[0].replace(/\D/g, '');
    if (cleaned.length < 8) return null;
    return cleaned.slice(-8);
}

function generateAllPhoneVariations(fullPhone) {
    const cleaned = String(fullPhone).split('@')[0].replace(/\D/g, '');
    if (cleaned.length < 8) return [];
    const v = new Set([cleaned]);
    if (!cleaned.startsWith('55')) v.add('55' + cleaned);
    if (cleaned.startsWith('55')) v.add(cleaned.substring(2));
    for (let i = 8; i <= Math.min(13, cleaned.length); i++) {
        const ln = cleaned.slice(-i); v.add(ln);
        if (!ln.startsWith('55')) v.add('55' + ln);
    }
    if (cleaned.length >= 11) {
        const ddd = cleaned.slice(-11, -9), num = cleaned.slice(-9);
        if (num[0] === '9') { const s = ddd + num.substring(1); v.add(s); v.add('55' + s); }
        else { const c = ddd + '9' + num; v.add(c); v.add('55' + c); }
    }
    if (cleaned.length === 12 && cleaned.startsWith('55')) { const n = '55' + cleaned.substring(2, 4) + '9' + cleaned.substring(4); v.add(n); v.add(n.substring(2)); }
    if (cleaned.length === 13 && cleaned.startsWith('55')) { const n = cleaned.substring(0, 4) + cleaned.substring(5); v.add(n); v.add(n.substring(2)); }
    return Array.from(v).filter(x => x && x.length >= 8);
}

function registerPhoneUniversal(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    const variations = generateAllPhoneVariations(fullPhone);
    const suffixes = ['@s.whatsapp.net', '@lid', '@g.us', ''];
    variations.forEach(v => { phoneIndex.set(v, phoneKey); phoneVariations.set(v, phoneKey); suffixes.forEach(s => { phoneIndex.set(v + s, phoneKey); phoneVariations.set(v + s, phoneKey); }); });
}

function findConversationUniversal(phone) {
    const phoneKey = normalizePhoneKey(phone);
    if (!phoneKey) return null;
    let conv = conversations.get(phoneKey);
    if (conv) { registerPhoneUniversal(phone, phoneKey); return conv; }
    const variations = generateAllPhoneVariations(phone);
    for (const v of variations) {
        const k = phoneIndex.get(v) || phoneVariations.get(v);
        if (k) { conv = conversations.get(k); if (conv) { registerPhoneUniversal(phone, k); return conv; } }
    }
    for (const [key, c] of conversations.entries()) {
        if (key === phoneKey || key.slice(-7) === phoneKey.slice(-7)) { registerPhoneUniversal(phone, key); return c; }
    }
    return null;
}

// ⭐ FIX 10/05: Regra de exclusividade de funil
// Cliente em qualquer funil ATIVO (não-cancelado, não-completo) só pode ser interrompido por APROVADA.
// Cliente que JÁ completou um funil anterior pode receber novo funil normalmente.
// Cliente em pixWaiting (timer dos 7min) também conta como ativo.
function hasActiveFunnelConversation(phoneKey) {
    const c = conversations.get(phoneKey);
    if (!c) return false;
    if (c.canceled || c.completed) return false;
    // pixWaiting=true (dentro dos 7min) ou conversa rodando → ATIVO
    return true;
}

// Retorna o tipo de funil ativo (pra log e decisão), ou null se nenhum
function getActiveFunnelType(phoneKey) {
    const c = conversations.get(phoneKey);
    if (!c || c.canceled || c.completed) return null;
    if (c.pixWaiting) return 'PIX_WAITING';
    return c.funnelType || (c.funnelId ? c.funnelId.split('_').pop() : null);
}

// ============ HIERARQUIA DE FUNIS ============
// Regra do Iago: ABANDONO (baixo) < PIX (meio) < APROVADA (topo).
//  - Evento de nível MAIOR cancela o funil ativo de nível menor e assume (transfere).
//    Ex: cliente em ABANDONO gera PIX → cancela abandono, começa PIX.
//        cliente em PIX paga → cancela PIX, começa APROVADA.
//  - Evento de nível IGUAL ou MENOR não dispara funil (duplicado, ou hierarquia inferior).
//    Ex: PIX enquanto já em PIX (2º Pix) → ignora. ABANDONO enquanto em PIX → ignora.
//  - Depois de pagar, nada de nível baixo dispara (ver hasPaidRecently).
const FUNNEL_LEVEL = { ABANDONO: 1, CARTAO_RECUSADO: 1, RECUPERACAO: 1, PIX_WAITING: 2, PIX: 2, APROVADA: 3 };
function funnelLevel(t) { return FUNNEL_LEVEL[t] || 0; }

// Epoch por telefone. Muda toda vez que um funil NOVO começa ou uma conversa é
// cancelada/transferida. O loop de envio (sendStep) captura o epoch na entrada e aborta
// se ele mudar — garante que um funil antigo NUNCA continua depois de ser substituído
// (ex: o PIX para na hora que o pagamento cai, sem mensagem órfã).
const convEpoch = new Map();
function bumpEpoch(phoneKey) { const e = (convEpoch.get(phoneKey) || 0) + 1; convEpoch.set(phoneKey, e); return e; }

// Cliente pagou nas últimas N horas? Bloqueia funis de nível baixo pós-venda.
function hasPaidRecently(phoneKey, hours = 24) {
    try {
        return !!db.getDb().prepare(
            `SELECT 1 FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) > datetime('now', ?) LIMIT 1`
        ).get(phoneKey, `-${parseInt(hours) || 24} hours`);
    } catch(e) { return false; }
}

// ============ LOCK ============
async function acquireWebhookLock(phoneKey, timeout = 10000) {
    const start = Date.now();
    while (webhookLocks.get(phoneKey)) { if (Date.now() - start > timeout) return false; await new Promise(r => setTimeout(r, 100)); }
    webhookLocks.set(phoneKey, true); return true;
}
function releaseWebhookLock(phoneKey) { webhookLocks.delete(phoneKey); }

// ============ HELPERS ============
function phoneToRemoteJid(phone) {
    let c = phone.replace(/\D/g, '');
    if (!c.startsWith('55')) c = '55' + c;
    if (c.length === 12) c = '55' + c.substring(2, 4) + '9' + c.substring(4);
    return c + '@s.whatsapp.net';
}

// ⭐ 22/07: telefone completo pra gravar no evento (lista de números pra contato manual)
function jidToPhone(remoteJid) {
    const p = String(remoteJid || '').split('@')[0].replace(/\D/g, '');
    return p || null;
}
function normalizeFullPhone(phone) {
    const p = String(phone || '').replace(/\D/g, '');
    if (!p) return null;
    return jidToPhone(phoneToRemoteJid(p));
}

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage) return message.imageMessage.caption || '[IMAGEM]';
    if (message.videoMessage) return message.videoMessage.caption || '[VÍDEO]';
    if (message.audioMessage) return '[ÁUDIO]';
    if (message.documentMessage) return '[DOCUMENTO]';
    if (message.stickerMessage) return '[FIGURINHA]';
    if (message.reactionMessage) return '[REAÇÃO]';
    if (message.viewOnceMessage) return '[MÍDIA ÚNICA]';
    return '[MENSAGEM]';
}

function addLog(type, message, data = null) {
    const log = { id: Date.now() + Math.random(), timestamp: new Date(), type, message, data };
    logs.unshift(log);
    if (logs.length > 500) logs = logs.slice(0, 500);
    console.log(`[${log.timestamp.toISOString()}] ${type}: ${message}`);
    sendSSE('log', { type, message, timestamp: log.timestamp });
}

// ============ DELAY COM VARIAÇÃO ALEATÓRIA ============
function randomDelay(seconds) {
    if (!seconds || seconds <= 0) return 0;
    const sec = parseInt(seconds);
    const min = Math.max(1, Math.round(sec * 0.8));
    const max = Math.round(sec * 1.2);
    return Math.floor(Math.random() * (max - min + 1) + min);
}

// ============ SINCRONIZAÇÃO MEMÓRIA → DB ============
function convToDb(phoneKey, conv) {
    db.saveConversation({
        phone_key: phoneKey,
        remote_jid: conv.remoteJid,
        funnel_id: conv.funnelId,
        step_index: conv.stepIndex,
        order_code: conv.orderCode,
        customer_name: conv.customerName,
        product_id: conv.productId,
        product_name: conv.productName,
        order_bumps: conv.orderBumps || [],
        amount: conv.amount || 0,
        amount_display: conv.amountDisplay,
        net_value: conv.netValue || 0,
        pix_code: conv.pixCode,
        payment_method: conv.paymentMethod || 'PIX',
        ddd: conv.ddd,
        city: conv.city,
        state: conv.state,
        waiting_for_response: conv.waiting_for_response,
        pix_waiting: conv.pixWaiting,
        sticky_instance: null,
        canceled: conv.canceled,
        completed: conv.completed,
        has_error: conv.hasError,
        invalid_number: conv.invalidNumber,
        transferred_from_pix: conv.transferredFromPix,
        paused: conv.paused,
        reactivation: conv.reactivation,
        ab_funnel_variant: conv.abFunnelVariant,
        created_at: conv.createdAt ? new Date(conv.createdAt).toISOString() : new Date().toISOString(),
        last_message_at: conv.lastSystemMessage ? new Date(conv.lastSystemMessage).toISOString() : null,
        last_reply_at: conv.lastReply ? new Date(conv.lastReply).toISOString() : null,
        completed_at: conv.completedAt ? new Date(conv.completedAt).toISOString() : null,
        canceled_at: conv.canceledAt ? new Date(conv.canceledAt).toISOString() : null,
        // ⭐ FIX 04/05: flags que perdiam no deploy
        awaiting_pool: conv.awaitingPool,
        waiting_for_sticky_return: conv.waitingForStickyReturn,
        funnel_type: conv.funnelType,
        last_send_error: conv.lastSendError,
        // ⭐ FIX 04/05: salva o link da página PIX (sem isso o restore não tem como recuperar — {PIX_LINK} cai pro fallback do código)
        checkout_url: conv.checkoutUrl,
        customer_email: conv.customerEmail,
    });
}

setInterval(() => { for (const [k, c] of conversations.entries()) convToDb(k, c); }, 15000);

setInterval(() => {
    const deleted = db.deleteOldConversations(CLEANUP_DAYS);
    if (deleted > 0) {
        for (const [k, c] of conversations.entries()) {
            if ((c.completed || c.canceled) && c.createdAt) {
                const age = (Date.now() - new Date(c.createdAt).getTime()) / 86400000;
                if (age > CLEANUP_DAYS) { conversations.delete(k); }
            }
        }
    }
}, 6 * 60 * 60 * 1000);

// ⭐ FIX 04/05: cleanup ágil do Map em memória (não só do banco). Conversa cancelada/concluída +24h sai do Map.
// Antes: Map crescia infinito (depois de 30 dias eram milhares de entries — gasto de memória + CPU em iteração).
setInterval(() => {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    let removed = 0;
    for (const [k, c] of conversations.entries()) {
        if ((c.completed || c.canceled) && c.createdAt && new Date(c.createdAt).getTime() < cutoff) {
            conversations.delete(k);
            removed++;
        }
    }
    if (removed > 0) addLog('MEM_CLEANUP', `🧹 ${removed} conversas finalizadas removidas da memória`);
}, 60 * 60 * 1000); // 1h

// ============ ENVIO PELO CANAL OFICIAL (Meta Cloud API) ============
// ⭐ 28/07: transporte trocado da Evolution pra API oficial. Regras da janela:
// - passo tipo "template" pode SEMPRE (é a única forma de iniciar conversa)
// - qualquer outro tipo só sai com janela de 24h ABERTA (cliente respondeu)
// - janela fechada → conversa fica aguardando resposta; quando o cliente responder,
//   o webhook da Meta chama advanceConversation e o funil continua de graça.
let _wabaNotConfiguredAlertAt = 0;
async function sendWithFallback(phoneKey, remoteJid, step, conversation, isFirstMessage = false) {
    if (isMessageBlocked(phoneKey, step, conversation)) {
        addLog('SEND_BLOCKED', `🚫 Duplicada bloqueada`, { phoneKey, stepId: step.id });
        return { success: false, blocked: true };
    }

    const finalText = replaceVariables(step.text, conversation);
    const finalMediaUrl = replaceVariables(step.mediaUrl, conversation);

    // Personalização por horário no passo 1
    let actualMediaUrl = finalMediaUrl;
    let actualText = finalText;
    if (step.timeVariants && conversation.stepIndex === 0) {
        const hour = new Date().getHours();
        const variant = hour < 12 ? step.timeVariants.morning : hour < 18 ? step.timeVariants.afternoon : step.timeVariants.evening;
        if (variant) { actualMediaUrl = variant.mediaUrl || actualMediaUrl; actualText = variant.text || actualText; }
    }

    if (!isWabaConfigured()) {
        if (Date.now() - _wabaNotConfiguredAlertAt > 10 * 60 * 1000) {
            _wabaNotConfiguredAlertAt = Date.now();
            try { await sendPushNotification('Envios parados — API oficial', 'WABA_TOKEN / WABA_PHONE_NUMBER_ID não configurados no EasyPanel. Nenhuma mensagem sai até configurar.', 'info'); } catch(e) {}
        }
        addLog('WA_NOT_CONFIGURED', `⚠️ API oficial não configurada — passo não enviado`, { phoneKey });
        return { success: false, error: 'WABA_NOT_CONFIGURED' };
    }

    const toPhone = jidToPhone(remoteJid) || jidToPhone(phoneToRemoteJid(phoneKey));

    // Janela de 24h: fora dela, só template inicia conversa
    if (step.type !== 'template' && !isWaWindowOpen(phoneKey)) {
        addLog('WA_WINDOW_CLOSED', `⏸️ Janela de 24h fechada — passo ${conversation.stepIndex + 1} (${step.type}) aguardando o cliente responder`, { phoneKey });
        return { success: false, windowClosed: true };
    }

    try {
        let message;
        if (step.type === 'template') {
            const tplName = step.templateName || (step.text || '').trim();
            if (!tplName) return { success: false, error: 'TEMPLATE_SEM_NOME' };
            // Variáveis do template — uma por linha. Dois formatos:
            //   "nome={NOME}"  → variável NOMEADA {{nome}} (padrão das contas novas da Meta)
            //   "{NOME}"       → variável numerada {{1}}, {{2}}... na ordem das linhas
            let components = null;
            const rawParams = Array.isArray(step.templateParams)
                ? step.templateParams
                : (typeof step.templateParams === 'string' && step.templateParams.trim() ? step.templateParams.split('\n') : []);
            const parsed = rawParams.map(line => {
                const s = String(line).trim();
                const eq = s.indexOf('=');
                if (eq > 0 && /^[a-z0-9_]+$/.test(s.slice(0, eq).trim())) {
                    return { name: s.slice(0, eq).trim(), value: replaceVariables(s.slice(eq + 1).trim(), conversation) };
                }
                return { name: null, value: replaceVariables(s, conversation) };
            }).filter(p => p.value !== '');
            if (parsed.length) {
                const named = parsed.some(p => p.name);
                components = [{ type: 'body', parameters: parsed.map(p => named
                    ? { type: 'text', parameter_name: p.name || '', text: p.value }
                    : { type: 'text', text: p.value }) }];
            }
            message = waTemplate(tplName, step.templateLang || 'pt_BR', components);
        }
        else if (step.type === 'text') message = waText(actualText);
        else if (step.type === 'image') message = waImage(actualMediaUrl);
        else if (step.type === 'image+text') message = waImage(actualMediaUrl, actualText);
        else if (step.type === 'video') message = waVideo(actualMediaUrl);
        else if (step.type === 'video+text') message = waVideo(actualMediaUrl, actualText);
        else if (step.type === 'audio') message = waAudio(actualMediaUrl);
        else if (step.type === 'sticker') message = { type: 'sticker', sticker: { link: actualMediaUrl } };
        else if (step.type === 'viewonce_image') message = waImage(actualMediaUrl); // API oficial não tem "ver 1x" — vai como imagem normal
        else if (step.type === 'viewonce_video') message = waVideo(actualMediaUrl);
        else if (step.type === 'buttons') {
            let header = null;
            if (actualMediaUrl) {
                if (/\.(mp4|mov)(\?|$)/i.test(actualMediaUrl)) header = { type: 'video', video: { link: actualMediaUrl } };
                else if (/\.(jpe?g|png|webp)(\?|$)/i.test(actualMediaUrl)) header = { type: 'image', image: { link: actualMediaUrl } };
            }
            const lines = String(step.buttonsText || '').split('\n').map(s => s.trim()).filter(Boolean);
            const footer = step.footerText ? replaceVariables(step.footerText, conversation) : null;
            // Linha com "Texto|https://..." = botão de LINK (só 1 por mensagem, regra da Meta)
            const urlLine = lines.find(l => /\|\s*https?:\/\//i.test(l));
            if (urlLine) {
                const [label, ...rest] = urlLine.split('|');
                message = waCtaUrl(actualText, replaceVariables(label.trim(), conversation), replaceVariables(rest.join('|').trim(), conversation), header, footer);
            } else {
                const btns = Array.isArray(step.buttons) && step.buttons.length
                    ? step.buttons
                    : lines.map((t, i) => ({ id: 'btn' + (i + 1), title: t }));
                message = waButtons(actualText, btns, header, footer);
            }
        }
        else return { success: true }; // tipo desconhecido: não trava o funil

        await waSendMessage(toPhone, message, { templateName: step.templateName || null });

        registerSentMessage(phoneKey, step, conversation);
        db.logMessage(phoneKey, 'out', actualText || actualMediaUrl, 'oficial', step.id);
        addLog('SEND_OK', `✅ Enviado pelo canal oficial`, { phoneKey, type: step.type });
        sendSSE('message_sent', { phoneKey, instance: 'oficial', stepType: step.type });
        return { success: true };
    } catch (e) {
        const msg = String(e.message || '');
        // 131047 = fora da janela de 24h (re-engagement) — trata como janela fechada
        if (msg.includes('131047') || msg.toLowerCase().includes('re-engagement')) {
            addLog('WA_WINDOW_CLOSED', `⏸️ Meta recusou: janela de 24h fechada — aguardando resposta do cliente`, { phoneKey });
            return { success: false, windowClosed: true };
        }
        // 131026 = número não tem WhatsApp / não pode receber
        if (msg.includes('131026')) {
            const conv = conversations.get(phoneKey);
            if (conv) { conv.invalidNumber = true; conv.canceled = true; conversations.set(phoneKey, conv); try { convToDb(phoneKey, conv); } catch(e2) {} }
            addLog('INVALID_NUMBER', `❌ Número sem WhatsApp: ${phoneKey}`, { phoneKey });
            return { success: false, invalidNumber: true };
        }
        return { success: false, error: msg.substring(0, 200) };
    }
}

// ============ ORQUESTRAÇÃO ============
// ============ ANTI-DUPLICATA COM COOLDOWN CONFIGURÁVEL ============
function getCooldownDays() {
    const setting = db.getSetting('FUNNEL_COOLDOWN_DAYS');
    // ⭐ FIX 04/05: parseInt('0') || 7 = 7. Agora respeita 0 (desativado).
    const v = parseInt(setting);
    return Number.isFinite(v) && v >= 0 ? v : 7;
}
function isTestModeActive() {
    try { return db.getSetting('TEST_MODE') === '1'; } catch { return false; }
}

function shouldBlockFunnelByCooldown(phoneKey, productId, funnelType) {
    // MODO TESTE: ignora cooldown sempre
    if (isTestModeActive()) {
        addLog('TEST_MODE_BYPASS', `🧪 Modo Teste: cooldown ignorado para ${phoneKey}`, { phoneKey });
        return null;
    }
    const days = getCooldownDays();
    if (days <= 0) return null;
    const recent = db.hasReceivedFunnelRecently(phoneKey, productId, funnelType, days);
    if (recent) {
        addLog('COOLDOWN_BLOCK', `⏸️ Cooldown ${days}d: ${phoneKey} já recebeu ${funnelType} de ${productId} em ${recent.received_at}`, { phoneKey });
        return recent;
    }
    return null;
}

// ============ PULAR PASSOS DE APRESENTAÇÃO (INTRO) QUANDO VEM DE PIX ============
// Se cliente foi transferido de PIX→Aprovado, pular passos marcados como is_intro=true
// pois cliente já recebeu a apresentação da modelo no funil de PIX.
function getFirstNonIntroStepIndex(funnelId) {
    const funnel = db.getFunnelById(funnelId);
    if (!funnel || !funnel.steps?.length) return 0;
    for (let i = 0; i < funnel.steps.length; i++) {
        if (!funnel.steps[i].is_intro) return i;
    }
    return 0; // todos são intro? começa do 0 mesmo (fallback seguro)
}

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location, pixExpiresAt, productsForSummary, customerEmail = null) {
    // ⭐ FIX 04/05: Race "APROVADA chega antes de PIX_GENERATED" (gateway atrasou primeiro webhook).
    // Sem isso: cliente recebe APROVADA, depois cria conversa PIX duplicada e funil PIX vai pra ele junto.
    // ⭐ FIX 10/05: janela ampliada 10min → 2h (gateways atrasam webhook em rajada) +
    // checagem extra: conversa APROVADA ativa no Map também bloqueia novo PIX.
    try {
        const recentPaid = db.getDb().prepare(
            `SELECT 1 FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) > datetime('now','-2 hours') LIMIT 1`
        ).get(phoneKey);
        if (recentPaid) {
            addLog('PIX_AFTER_PAID', `⏸️ PIX_GENERATED ignorado — cliente JÁ pagou nas últimas 2h (${phoneKey})`);
            return;
        }
        // Conversa em memória já é APROVADA → bloqueia PIX duplicado por race entre gateways
        const memConv = conversations.get(phoneKey);
        if (memConv && !memConv.canceled && memConv.funnelType === 'APROVADA') {
            addLog('PIX_BLOCKED_APROVADA_ACTIVE', `⏸️ PIX_GENERATED ignorado — APROVADA em andamento (${phoneKey})`);
            return;
        }
    } catch(e) {}

    const existing = conversations.get(phoneKey);
    // ⭐ FIX 10/05: Cliente que JÁ COMPLETOU funil anterior pode receber PIX novo.
    // Só bloqueia se a conversa ainda está ATIVA (não-cancelada E não-completa).
    if (existing && !existing.canceled && !existing.completed) {
        const existingLevel = funnelLevel(getActiveFunnelType(phoneKey));
        // MODO TESTE: cancela automaticamente a conversa existente pra poder testar de novo
        if (isTestModeActive()) {
            existing.canceled = true;
            existing.canceledAt = new Date();
            conversations.set(phoneKey, existing);
            try { convToDb(phoneKey, existing); } catch(e) {}
            // Limpa timer PIX se havia
            const pt = pixTimeouts.get(phoneKey);
            if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
            try { db.deletePixTimeout(phoneKey); } catch(e) {}
            bumpEpoch(phoneKey);
            addLog('TEST_MODE_CANCEL', `🧪 Modo Teste: conversa anterior cancelada para ${phoneKey}`, { phoneKey });
        } else if (existingLevel < funnelLevel('PIX')) {
            // ⭐ FIX 07/26 HIERARQUIA: PIX é nível maior que ABANDONO/CARTÃO RECUSADO —
            // cancela o funil de baixo em andamento e assume (transfere pro PIX).
            existing.canceled = true;
            existing.canceledAt = new Date();
            existing.cancelReason = 'upgrade_para_pix';
            conversations.set(phoneKey, existing);
            try { convToDb(phoneKey, existing); } catch(e) {}
            bumpEpoch(phoneKey); // mata o loop do funil de abandono na hora
            addLog('PIX_UPGRADE', `⬆️ PIX assumiu — cancelado funil ${existing.funnelType || 'anterior'} em andamento (${phoneKey})`, { phoneKey });
        } else {
            // Mesmo nível (2º Pix) ou nível maior (APROVADA) já ativo → não dispara PIX duplicado.
            addLog('PIX_BLOCKED', `Já existe para ${phoneKey} (funil ${existing.funnelType || existing.funnelId} ativo)`);
            return;
        }
    }

    // Anti-duplicata: se recebeu funil PIX para este produto recentemente, não dispara
    if (shouldBlockFunnelByCooldown(phoneKey, productId, 'PIX')) {
        db.recordEvent('PIX_GENERATED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });
        sendSSE('pix_generated', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode, skipped: true });
        {
            // ⭐ FIX 06/26: PIX em cooldown não notificava nada — parecia que o sistema falhou. Agora o push avisa.
            const notif = buildPaymentNotification('pix_generated', customerName, netValue || amount, productName);
            await sendPushNotification(notif.title, notif.body + ' · repetido, funil não disparado', notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
        }
        addLog('PIX_SKIPPED', `⏸️ PIX registrado mas funil não disparado (cooldown) para ${phoneKey}`, { orderCode });
        return;
    }

    // Gera página PIX única para este cliente (link facilitado de copy)
    const appUrl = process.env.APP_URL || '';
    let generatedPixUrl = null;
    if (appUrl && pixCode) {
        try {
            const crypto = require('crypto');
            const token = crypto.randomBytes(8).toString('hex');
            const amountDisp = 'R$ ' + (amount || 0).toFixed(2).replace('.', ',');
            // expires_at vem do webhook (data.payment.expires_at) — fallback: 24h
            const expiresAt = pixExpiresAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
            const productsJson = productsForSummary && productsForSummary.length ? JSON.stringify(productsForSummary) : null;
            db.createPixPage(token, phoneKey, pixCode, customerName, amountDisp, productName, expiresAt, productId, productsJson);
            generatedPixUrl = `${appUrl.replace(/\/$/, '')}/pix/${token}`;
        } catch(e) { console.error('Erro ao criar página PIX:', e.message); }
    }

    // ⭐ 22/07: kill switch / regra de valor — registra evento, notifica e gera a página PIX
    // (o link continua disponível na aba Números pro envio manual), mas NÃO cria funil nem timer.
    const pixBlockReason = autoSendBlockReason('PIX', amount, phoneKey);
    if (pixBlockReason) {
        db.recordEvent('PIX_GENERATED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });
        sendSSE('pix_generated', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode, skipped: true });
        try {
            const notif = buildPaymentNotification('pix_generated', customerName, netValue || amount, productName);
            await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
        } catch(e) {}
        addLog('AUTO_SEND_BLOCKED', `⏸️ Funil PIX não disparado — ${pixBlockReason} (${customerName})`, { phoneKey, orderCode });
        return;
    }

    const conv = {
        phoneKey, remoteJid, funnelId: productId + '_PIX', stepIndex: -1, orderCode, customerName, customerEmail,
        productId, productName, orderBumps: orderBumps || [], amount, amountDisplay: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','),
        netValue, pixCode, checkoutUrl: generatedPixUrl, paymentMethod: paymentMethod || 'PIX',
        ddd: location?.ddd, city: location?.city, state: location?.state,
        waiting_for_response: false, pixWaiting: true, funnelType: 'PIX',
        createdAt: new Date(), canceled: false, completed: false, paused: false
    };

    conversations.set(phoneKey, conv);
    bumpEpoch(phoneKey); // novo funil PIX — invalida qualquer loop anterior
    registerPhoneUniversal(remoteJid, phoneKey);
    try { convToDb(phoneKey, conv); } catch(e) {} // persiste imediato pro rollback seguro

    db.recordEvent('PIX_GENERATED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });

    sendSSE('pix_generated', { phoneKey, customerName, productName, amount: conv.amountDisplay, netValue: netValue || amount, orderCode });
    {
        const notif = buildPaymentNotification('pix_generated', customerName, netValue || amount, productName);
        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
    }
    addLog('PIX_WAITING', `⏳ PIX aguardando para ${phoneKey}`, { orderCode });

    const timeout = setTimeout(async () => {
        const c = conversations.get(phoneKey);
        // ⭐ 22/07: re-checa o kill switch na hora do disparo (pode ter sido desligado durante os 7min)
        const fireBlockReason = c ? autoSendBlockReason('PIX', amount, phoneKey) : null;
        if (c && fireBlockReason && c.orderCode === orderCode && !c.canceled && c.pixWaiting) {
            c.canceled = true; c.canceledAt = new Date(); c.cancelReason = 'envio_desligado';
            conversations.set(phoneKey, c);
            try { convToDb(phoneKey, c); } catch(e) {}
            bumpEpoch(phoneKey);
            addLog('AUTO_SEND_BLOCKED', `⏸️ Funil PIX cancelado no disparo — ${fireBlockReason} (${c.customerName || phoneKey})`, { phoneKey, orderCode });
        } else if (c && c.orderCode === orderCode && !c.canceled && c.pixWaiting) {
            c.pixWaiting = false; c.stepIndex = 0;
            const selectedFunnel = selectABFunnel(productId, 'PIX');
            c.funnelId = selectedFunnel; c.abFunnelVariant = selectedFunnel;
            conversations.set(phoneKey, c);
            bumpEpoch(phoneKey); // 7min expiraram — funil PIX começa agora
            db.recordABResult(selectedFunnel, false);
            db.recordFunnelReceipt(phoneKey, productId, 'PIX', selectedFunnel);
            await sendStep(phoneKey);
        }
        pixTimeouts.delete(phoneKey);
        try { db.deletePixTimeout(phoneKey); } catch(e) {}
    }, getPixTimeoutMs());

    pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
    // ROLLBACK SEGURO: persiste timer no banco para sobreviver a deploy
    try {
        const fireAt = new Date(Date.now() + getPixTimeoutMs()).toISOString();
        db.savePixTimeout(phoneKey, orderCode, fireAt);
    } catch(e) { console.error('Erro ao persistir timer PIX:', e.message); }
}

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, orderBumps, paymentMethod, location, customerEmail = null) {
    const pixConv = conversations.get(phoneKey);
    const pixCode = pixConv?.pixCode;
    const abVariant = pixConv?.abFunnelVariant;

    if (pixConv) { pixConv.canceled = true; pixConv.canceledAt = new Date(); conversations.set(phoneKey, pixConv); }
    bumpEpoch(phoneKey); // pagamento cancela o funil PIX — mata o loop na hora
    const pt = pixTimeouts.get(phoneKey);
    if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
    try { db.deletePixTimeout(phoneKey); } catch(e) {}

    db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps, funnel_id: abVariant, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });
    // ⭐ FIX 04/05: libera cooldown PIX desse produto agora que cliente pagou (permite recompra futura)
    try { db.clearFunnelReceiptOnPayment(phoneKey, productId); } catch(e) {}
    // ⭐ FIX 11/05: cliente pagou — cancela QUALQUER agendamento de recuperação pendente (proteção dupla)
    try {
        const cancelled = db.cancelScheduledFunnelsByPhone(phoneKey, 'cliente_pagou');
        if (cancelled > 0) addLog('RECOVERY_CANCEL_PAID_LIVE', `🚫 ${cancelled} agendamento(s) de recuperação cancelado(s) — cliente acabou de pagar`, { phoneKey });
    } catch(e) {}
    if (abVariant) db.recordABResult(abVariant, true);

    const amountDisplay = formatBRL(netValue || amount);
    sendSSE('payment_approved', { phoneKey, customerName, productName, amount: amountDisplay, netValue: netValue || amount, paymentMethod: paymentMethod || 'PIX' });
    {
        const isCard = paymentMethod === 'CREDIT_CARD';
        const notif = buildPaymentNotification(isCard ? 'card_paid' : 'pix_paid', customerName, netValue || amount, productName);
        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
    }

    // ⭐ 22/07: kill switch / valor mínimo — a venda JÁ foi registrada e notificada acima; só o funil não sai
    const aprovadaBlockReason = autoSendBlockReason('APROVADA', amount, phoneKey);
    if (aprovadaBlockReason) {
        addLog('AUTO_SEND_BLOCKED', `⏸️ Funil APROVADA não disparado — ${aprovadaBlockReason} (${customerName})`, { phoneKey, orderCode });
        return;
    }

    const selectedFunnel = selectABFunnel(productId, 'APROVADA');
    // Só pula apresentação se cliente JÁ recebeu mensagens no funil PIX (timer dos 7min disparou).
    // Se cliente pagou ANTES do timer disparar, pixWaiting=true e ele NÃO recebeu apresentação ainda.
    const recebeuIntroNoPIX = pixConv && !pixConv.pixWaiting && (pixConv.stepIndex || 0) >= 0;
    const startStepIndex = recebeuIntroNoPIX ? getFirstNonIntroStepIndex(selectedFunnel) : 0;
    if (startStepIndex > 0) addLog('SKIP_INTRO', `⏭️ Pulando ${startStepIndex} passo(s) de apresentação (cliente já recebeu intro no PIX)`, { phoneKey, funnelId: selectedFunnel });
    else if (pixConv?.pixWaiting) addLog('KEEP_INTRO', `▶️ Cliente pagou antes dos 7min — começando do início (apresentação preservada)`, { phoneKey, funnelId: selectedFunnel });
    const conv = {
        phoneKey, remoteJid, funnelId: selectedFunnel, stepIndex: startStepIndex, orderCode, customerName,
        customerEmail: customerEmail || pixConv?.customerEmail || null,
        productId, productName, orderBumps: orderBumps || [], amount, amountDisplay, netValue, pixCode,
        paymentMethod: paymentMethod || 'PIX', ddd: location?.ddd, city: location?.city, state: location?.state,
        waiting_for_response: false, createdAt: new Date(), lastSystemMessage: new Date(),
        canceled: false, completed: false, paused: false, transferredFromPix: true, abFunnelVariant: selectedFunnel,
        funnelType: 'APROVADA'
    };
    conversations.set(phoneKey, conv);
    bumpEpoch(phoneKey); // funil APROVADA assume — novo epoch pro loop dele
    registerPhoneUniversal(remoteJid, phoneKey);
    db.recordABResult(selectedFunnel, false);
    db.recordFunnelReceipt(phoneKey, productId, 'APROVADA', selectedFunnel);
    // ⭐ 12/05: delay opcional pra 1ª msg APROVADA (default 0=instantâneo, configurável via APROVADA_DELAY_MS)
    await scheduleFirstStep(phoneKey, 'APROVADA');
}

async function startFunnel(phoneKey, remoteJid, funnelType, orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location, customFunnelId = null, customerEmail = null) {
    const existing = conversations.get(phoneKey);
    // ⭐ FIX 10/05: cliente que JÁ COMPLETOU funil anterior pode receber novo funil.
    // Só bloqueia se a conversa anterior ainda está ATIVA (não-cancelada E não-completa).
    if (existing && !existing.canceled && !existing.completed) {
        // ⭐ FIX 20/07 v3.6.3: gateway RETENTA o webhook de aprovada (mesma venda chega 2-3x).
        // Antes: o duplicado CANCELAVA o funil APROVADA em andamento e o cooldown barrava o novo —
        // resultado: áudio saía, cliente respondia e nada acontecia (conversa morta em silêncio).
        // Agora: mesmo pedido (orderCode) → ignora sem tocar no funil vivo.
        if (funnelType === 'APROVADA' && !isTestModeActive() && existing.orderCode === orderCode) {
            addLog('APROVADA_DUP', `🔁 Webhook repetido da venda ${orderCode} ignorado — funil em andamento preservado`, { phoneKey });
            return;
        }
        // ⭐ FIX 20/07 v3.6.3: cooldown checado ANTES de cancelar. Se o funil novo não vai disparar
        // (cooldown), não mata o que está rodando. Venda nova real ainda é registrada (receita).
        if (funnelType === 'APROVADA' && !isTestModeActive() && shouldBlockFunnelByCooldown(phoneKey, productId, funnelType)) {
            db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });
            addLog('APROVADA_COOLDOWN_KEEP', `⏸️ APROVADA em cooldown — venda registrada, funil atual preservado`, { phoneKey, orderCode });
            return;
        }
        // ⭐ FIX 05/05: APROVADA SEMPRE substitui qualquer funil em andamento (ABANDONO, CARTAO_RECUSADO, REATIVACAO).
        // Antes: cliente em ABANDONO que pagasse retornava FUNNEL_BLOCKED e nunca recebia APROVADA.
        if (funnelType === 'APROVADA' || isTestModeActive()) {
            existing.canceled = true;
            existing.canceledAt = new Date();
            existing.cancelReason = funnelType === 'APROVADA' ? 'transferido_para_aprovada' : 'test_mode';
            conversations.set(phoneKey, existing);
            try { convToDb(phoneKey, existing); } catch(e) {}
            const pt = pixTimeouts.get(phoneKey);
            if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
            try { db.deletePixTimeout(phoneKey); } catch(e) {}
            bumpEpoch(phoneKey); // cancela o funil anterior — mata o loop dele
            if (funnelType === 'APROVADA') {
                addLog('APROVADA_TRANSFER', `💰 Cliente em ${existing.funnelType || existing.funnelId} pagou — transferindo pra APROVADA`, { phoneKey });
            } else {
                addLog('TEST_MODE_CANCEL', `🧪 Modo Teste: conversa anterior cancelada para ${phoneKey}`, { phoneKey });
            }
        } else {
            addLog('FUNNEL_BLOCKED', `Já existe para ${phoneKey}`);
            return;
        }
    }

    // Anti-duplicata por cooldown (sempre registra o evento, mas não dispara mensagem se dentro do cooldown)
    if (shouldBlockFunnelByCooldown(phoneKey, productId, funnelType)) {
        if (funnelType === 'APROVADA') {
            db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });
        }
        addLog('FUNNEL_SKIPPED', `⏸️ ${funnelType} registrado mas funil não disparado (cooldown) para ${phoneKey}`, { orderCode });
        // ⭐ FIX 06/26: abandono/cartão recusado em cooldown eram 100% silenciosos — agora o push avisa
        if (funnelType === 'ABANDONO' || funnelType === 'CARTAO_RECUSADO') {
            try {
                const notif = buildPaymentNotification(funnelType === 'ABANDONO' ? 'cart_abandoned' : 'card_refused', customerName, netValue || amount, productName);
                await sendPushNotification(notif.title, notif.body + ' · repetido, funil não disparado', notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
            } catch(e) {}
        }
        return;
    }

    if (funnelType === 'APROVADA') {
        db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: jidToPhone(remoteJid) });
        // ⭐ FIX 04/05: libera cooldown PIX (cliente pagou — pode receber funil PIX de novo se gerar outro)
        try { db.clearFunnelReceiptOnPayment(phoneKey, productId); } catch(e) {}
        // ⭐ FIX 11/05: cliente pagou — cancela QUALQUER agendamento de recuperação pendente
        try {
            const cancelled = db.cancelScheduledFunnelsByPhone(phoneKey, 'cliente_pagou');
            if (cancelled > 0) addLog('RECOVERY_CANCEL_PAID_LIVE', `🚫 ${cancelled} agendamento(s) de recuperação cancelado(s) — cliente acabou de pagar`, { phoneKey });
        } catch(e) {}
        const amtDisplay = formatBRL(netValue || amount);
        sendSSE('payment_approved', { phoneKey, customerName, productName, amount: amtDisplay, netValue: netValue || amount, paymentMethod: paymentMethod || 'PIX' });
        {
            const isCard = paymentMethod === 'CREDIT_CARD';
            const notif = buildPaymentNotification(isCard ? 'card_paid' : 'pix_paid', customerName, netValue || amount, productName);
            await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
        }
    }

    // ⭐ 22/07: kill switch / valor mínimo — eventos/notificações acima já saíram; só o funil não dispara
    const blockReason = autoSendBlockReason(funnelType, amount, phoneKey);
    if (blockReason) {
        addLog('AUTO_SEND_BLOCKED', `⏸️ Funil ${funnelType} não disparado — ${blockReason} (${customerName})`, { phoneKey, orderCode });
        return;
    }

    // ⭐ FIX 11/05: aceita customFunnelId (usado por job de RECUPERAÇÃO pra forçar o funil escolhido no admin)
    const selectedFunnel = customFunnelId || selectABFunnel(productId, funnelType);
    const amountDisplay = 'R$ ' + (netValue || amount || 0).toFixed(2).replace('.', ',');
    const conv = {
        phoneKey, remoteJid, funnelId: selectedFunnel, stepIndex: 0, orderCode, customerName, customerEmail,
        productId, productName, orderBumps: orderBumps || [], amount, amountDisplay, netValue, pixCode,
        paymentMethod: paymentMethod || 'PIX', ddd: location?.ddd, city: location?.city, state: location?.state,
        waiting_for_response: false, createdAt: new Date(),
        canceled: false, completed: false, paused: false, abFunnelVariant: selectedFunnel,
        funnelType
    };
    conversations.set(phoneKey, conv);
    bumpEpoch(phoneKey); // funil novo — invalida qualquer loop anterior
    registerPhoneUniversal(remoteJid, phoneKey);
    db.recordABResult(selectedFunnel, false);
    db.recordFunnelReceipt(phoneKey, productId, funnelType, selectedFunnel);
    addLog('FUNNEL_START', `🚀 Iniciando ${selectedFunnel} para ${phoneKey}${customFunnelId ? ' (custom)' : ''}`, { orderCode });
    // ⭐ 12/05: delay opcional pra 1ª msg (default 0=instantâneo). ABANDONO usa ABANDONO_DELAY_MS, APROVADA usa APROVADA_DELAY_MS.
    await scheduleFirstStep(phoneKey, funnelType);
}

// ============ SEND STEP ============
// Rate-limit do alerta "funil vazio" (não spammar push se muitos leads caírem no mesmo funil vazio)
const _emptyFunnelAlert = new Map();
// Helper: re-checa se a conversa foi cancelada/pausada/paga durante um await (evita enviar msg pra cliente que já pagou)
function isConvAlive(phoneKey) {
    const c = conversations.get(phoneKey);
    return c && !c.canceled && !c.completed && !c.paused && !c.invalidNumber;
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled || conversation.pixWaiting || conversation.paused || conversation.invalidNumber) return;

    // ⭐ 22/07: kill switch — interrompe funis que NÓS iniciamos (PIX/APROVADA/ABANDONO/...).
    // ⭐ 29/07: funis iniciados PELO CLIENTE (atendimento de anúncio, palavra-chave, reativação,
    // envio manual) NÃO são bloqueados: são grátis, esperados e sem risco de bloqueio.
    const INBOUND_TYPES = ['MANUAL', 'DIRETO', 'REATIVACAO', 'ATENDIMENTO'];
    if (!INBOUND_TYPES.includes(conversation.funnelType) && !isAutoSendEnabled()) {
        conversation.canceled = true; conversation.canceledAt = new Date(); conversation.cancelReason = 'envio_desligado';
        conversations.set(phoneKey, conversation);
        try { convToDb(phoneKey, conversation); } catch(e) {}
        bumpEpoch(phoneKey);
        addLog('AUTO_SEND_BLOCKED', `⏸️ Envio automático desligado — funil ${conversation.funnelType || conversation.funnelId} interrompido (${conversation.customerName || phoneKey})`, { phoneKey });
        return;
    }

    // ⭐ FIX 07/26: guard por EPOCH. Captura o epoch do funil na entrada; se ele mudar (funil novo
    // começou, ou a conversa foi transferida/cancelada), este loop aborta na próxima checagem.
    // Cobre o caso "paguei e o PIX continuou": o pagamento troca o epoch, o loop do PIX morre na hora.
    const myEpoch = convEpoch.get(phoneKey);
    const stillCurrent = () => convEpoch.get(phoneKey) === myEpoch && conversations.get(phoneKey) === conversation && isConvAlive(phoneKey);

    const funnel = db.getFunnelById(conversation.funnelId);
    if (!funnel || !funnel.steps?.length) {
        // ⭐ FIX 07/26: funil vazio/não encontrado é a causa nº1 de "chega evento mas não envia".
        // Antes ficava só num log escondido — agora avisa o operador no celular (1x a cada 10min por funil).
        addLog('FUNNEL_EMPTY', `⚠️ Funil ${conversation.funnelId} vazio ou não existe — ${conversation.customerName || phoneKey} NÃO recebeu (tipo ${conversation.funnelType || '?'})`, { phoneKey });
        try {
            const alertKey = 'empty_' + conversation.funnelId;
            const last = _emptyFunnelAlert.get(alertKey) || 0;
            if (Date.now() - last > 10 * 60 * 1000) {
                _emptyFunnelAlert.set(alertKey, Date.now());
                await sendPushNotification('Funil sem mensagens', `${conversation.funnelType || 'Funil'} "${conversation.funnelId}" está vazio — configure no painel. Cliente não recebeu.`, 'info');
            }
        } catch(e) {}
        return;
    }

    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;

    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    addLog('STEP_START', `📤 Passo ${conversation.stepIndex + 1}/${funnel.steps.length} [${step.type}]`, { phoneKey, funnelId: conversation.funnelId });

    // ⭐ FIX 04/05: garante checkoutUrl ANTES de interpolar mensagens. Cobre conversas antigas que ficaram com null
    // no banco (resíduo do bug de persistência). Se mensagem usa {PIX_LINK} e ainda não temos URL, regenera agora.
    const stepText = step.text || '';
    const stepMedia = step.mediaUrl || '';
    if ((stepText.includes('{PIX_LINK}') || stepMedia.includes('{PIX_LINK}')) && !conversation.checkoutUrl && conversation.pixCode) {
        try {
            const appUrl = process.env.APP_URL || '';
            if (appUrl) {
                const cryptoMod = require('crypto');
                const token = cryptoMod.randomBytes(8).toString('hex');
                const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
                db.createPixPage(token, phoneKey, conversation.pixCode, conversation.customerName || 'Cliente', conversation.amountDisplay || '', conversation.productName || '', expiresAt, conversation.productId || null, null);
                conversation.checkoutUrl = `${appUrl.replace(/\/$/, '')}/pix/${token}`;
                conversations.set(phoneKey, conversation);
                try { convToDb(phoneKey, conversation); } catch(e) {}
                addLog('PIX_LINK_REGEN', `🔗 Link PIX regenerado em runtime para ${phoneKey}`, { token });
            }
        } catch(e) { addLog('PIX_LINK_REGEN_ERR', `⚠️ Falha regenerar página PIX: ${e.message}`, { phoneKey }); }
    }

    // Delay com variação aleatória (API oficial não tem "digitando…" — só o tempo)
    if (step.delayBefore && parseInt(step.delayBefore) > 0) {
        const originalSecs = parseInt(step.delayBefore);
        const actualSecs = randomDelay(originalSecs);
        addLog('STEP_DELAY', `⏱️ delayBefore: ${originalSecs}s → ${actualSecs}s (±20%)`, { phoneKey });
        await new Promise(r => setTimeout(r, actualSecs * 1000));
        // ⭐ FIX 04/05: Cliente pode ter pago durante o sleep — recheck antes de enviar msg de cobrança
        if (!stillCurrent()) { addLog('STEP_ABORT', `⏸️ Conversa morreu/foi substituída durante delay (provável pagamento)`, { phoneKey }); return; }
    } else if (step.showTyping && step.type !== 'delay') {
        const typingSecs = randomDelay(parseInt(step.typingSeconds || 3));
        await new Promise(r => setTimeout(r, typingSecs * 1000));
        if (!stillCurrent()) { addLog('STEP_ABORT', `⏸️ Conversa morreu/foi substituída durante typing`, { phoneKey }); return; }
    }

    let result = { success: true };

    if (step.type === 'delay') {
        const actualSecs = randomDelay(parseInt(step.delaySeconds || 10));
        addLog('STEP_DELAY_EX', `⏱️ Delay: ${actualSecs}s`, { phoneKey });
        await new Promise(r => setTimeout(r, actualSecs * 1000));
        if (!stillCurrent()) { addLog('STEP_ABORT', `⏸️ Conversa morreu/foi substituída durante delay step`, { phoneKey }); return; }
    } else {
        if (step.waitForReply) { conversation.waiting_for_response = true; conversations.set(phoneKey, conversation); }
        // ⭐ FIX 04/05: try/catch protetor pra exception em sendWithFallback não deixar lead órfão com waiting_for_response=true
        try {
            result = await sendWithFallback(phoneKey, conversation.remoteJid, step, conversation, isFirstMessage);
        } catch(e) {
            addLog('SEND_THROW', `💥 Exception em sendWithFallback: ${e.message}`, { phoneKey });
            if (step.waitForReply) conversation.waiting_for_response = false;
            conversation.hasError = true;
            conversation.lastSendError = 'EXCEPTION';
            conversations.set(phoneKey, conversation);
            try { convToDb(phoneKey, conversation); } catch {}
            return;
        }
        if (result.blocked) {
            if (step.waitForReply) { conversation.waiting_for_response = false; conversations.set(phoneKey, conversation); }
            return;
        }
        // ⭐ 28/07: janela de 24h fechada — conversa fica AGUARDANDO o cliente responder.
        // Quando a resposta chegar, o webhook da Meta chama advanceConversation e o funil segue de graça.
        if (result.windowClosed) {
            conversation.waiting_for_response = true;
            conversation.awaitingWindow = true;
            conversations.set(phoneKey, conversation);
            try { convToDb(phoneKey, conversation); } catch(e) {}
            addLog('STEP_WAIT', `⏸️ Passo ${conversation.stepIndex + 1} aguardando janela (cliente precisa responder)`, { phoneKey });
            return;
        }
        if (result.invalidNumber) {
            // ⭐ FIX 04/05: garante reset do flag em número inválido (UI/recovery não acreditava no canceled)
            if (step.waitForReply) { conversation.waiting_for_response = false; conversations.set(phoneKey, conversation); }
            return;
        }

        // ⭐ FIX 04/05: falha de envio sem ser blocked/invalidNumber (pool vazio ou todas instâncias falharam)
        // Antes esse caminho deixava waiting_for_response=true e o lead ficava órfão pra sempre.
        if (!result.success) {
            if (step.waitForReply) conversation.waiting_for_response = false;
            conversation.hasError = true;
            conversation.lastSendError = result.error || 'SEND_FAILED';
            conversation.lastErrorAt = new Date();
            conversations.set(phoneKey, conversation);
            try { convToDb(phoneKey, conversation); } catch(e) {}
            addLog('STEP_FAILED', `❌ Passo ${conversation.stepIndex+1} falhou — agendado pra retry (${conversation.lastSendError})`, { phoneKey });
            return;
        }
    }

    if (result.success) {
        // ⭐ FIX 06/26: se a conversa foi substituída DURANTE o envio (pagamento chegou no meio do HTTP),
        // não regrava a antiga no Map nem avança o passo — senão o funil APROVADA pularia mensagens.
        if (!stillCurrent()) {
            addLog('STEP_ABORT', `⏸️ Funil substituído durante envio — não avança passo`, { phoneKey });
            return;
        }
        conversation.lastSystemMessage = new Date();
        conversations.set(phoneKey, conversation);
        if (step.waitForReply && step.type !== 'delay') {
            addLog('STEP_WAIT', `⏸️ Aguardando resposta (passo ${conversation.stepIndex + 1})`, { phoneKey });
        } else {
            await advanceConversation(phoneKey, null, 'auto', myEpoch);
        }
    }
}

async function advanceConversation(phoneKey, replyText, reason, expectedEpoch) {
    // ⭐ FIX 07/26: se veio de um loop de funil que já foi substituído (epoch mudou), não avança.
    // Impede o funil antigo (ex: PIX pós-pagamento) de empurrar o próximo passo do funil novo.
    if (expectedEpoch !== undefined && convEpoch.get(phoneKey) !== expectedEpoch) {
        addLog('ADVANCE_STALE', `⏸️ Avanço ignorado — funil já foi substituído`, { phoneKey });
        return;
    }
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled || conversation.paused) return;

    // Verifica gatilhos globais na resposta
    if (reason === 'reply' && replyText) {
        const trigger = checkTriggers(replyText, conversation);
        if (trigger) {
            addLog('TRIGGER_ACTION', `🎯 Executando gatilho: ${trigger.name}`, { phoneKey, autoBlock: trigger.auto_block });

            if (trigger.auto_block) {
                db.addToBlacklist(phoneKey, conversation.remoteJid, `Gatilho: ${trigger.name}`);
                sendSSE('lead_blocked', { phoneKey, reason: trigger.name });
            }

            if (!trigger.target_funnel_id || trigger.target_funnel_id === 'ENCERRAR') {
                conversation.canceled = true; conversation.canceledAt = new Date();
                conversation.cancelReason = trigger.name;
                conversations.set(phoneKey, conversation);
                addLog('TRIGGER_STOP', `🛑 Fluxo encerrado por gatilho`, { phoneKey });
                return;
            }

            conversation.funnelId = trigger.target_funnel_id;
            conversation.stepIndex = 0;
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            await sendStep(phoneKey);
            return;
        }
    }

    // ⭐ 28/07: o passo atual ficou PRESO esperando a janela de 24h abrir (não foi enviado).
    // A resposta do cliente abriu a janela — reenvia o passo pendente em vez de pular pro próximo.
    if (reason === 'reply' && conversation.awaitingWindow) {
        conversation.awaitingWindow = false;
        conversation.waiting_for_response = false;
        conversation.lastReply = new Date();
        conversations.set(phoneKey, conversation);
        try { convToDb(phoneKey, conversation); } catch(e) {}
        addLog('WA_WINDOW_OPEN', `▶️ Cliente respondeu — janela aberta, enviando o passo ${conversation.stepIndex + 1} que estava aguardando`, { phoneKey });
        await sendStep(phoneKey);
        return;
    }

    const funnel = db.getFunnelById(conversation.funnelId);
    if (!funnel) return;

    const nextStepIndex = conversation.stepIndex + 1;

    if (nextStepIndex >= funnel.steps.length) {
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(phoneKey, conversation);
        convToDb(phoneKey, conversation);
        if (conversation.abFunnelVariant) db.recordABResult(conversation.abFunnelVariant, false);
        addLog('FUNNEL_DONE', `✅ Funil concluído`, { phoneKey });
        sendSSE('funnel_completed', { phoneKey, customerName: conversation.customerName });

        // ⭐ FIX 11/05: Agendar funil de RECUPERAÇÃO se PIX ou ABANDONO completou sem pagamento
        // Proteção principal: cliente que JÁ PAGOU alguma vez NÃO recebe oferta de R$9,99 (queima a base)
        try {
            const recoveryEnabled = db.getSetting('RECOVERY_FUNNEL_ENABLED') === '1';
            if (recoveryEnabled && (conversation.funnelType === 'PIX' || conversation.funnelType === 'ABANDONO')) {
                const targetFunnelId = conversation.funnelType === 'PIX'
                    ? db.getSetting('RECOVERY_FUNNEL_ID_PIX')
                    : db.getSetting('RECOVERY_FUNNEL_ID_ABANDONO');
                if (targetFunnelId) {
                    if (db.hasEverPaid(phoneKey)) {
                        addLog('RECOVERY_SKIP_PAID', `⏭️ Recuperação NÃO agendada — ${conversation.customerName || phoneKey} já é cliente pagante`, { phoneKey });
                    } else {
                        const delayHours = parseInt(db.getSetting('RECOVERY_DELAY_HOURS') || '24');
                        const fireAt = new Date(Date.now() + delayHours * 60 * 60 * 1000).toISOString();
                        const id = db.scheduleFunnel({
                            phone_key: phoneKey,
                            remote_jid: conversation.remoteJid,
                            customer_name: conversation.customerName,
                            product_id: conversation.productId,
                            product_name: conversation.productName,
                            funnel_id: targetFunnelId,
                            funnel_type: 'RECUPERACAO',
                            trigger_source: conversation.funnelType + '_COMPLETED',
                            fire_at: fireAt
                        });
                        if (id) {
                            addLog('RECOVERY_SCHEDULED', `🔁 Recuperação agendada pra ${conversation.customerName || phoneKey} em ${delayHours}h (origem: ${conversation.funnelType})`, { phoneKey, scheduleId: id });
                        }
                    }
                }
            }
        } catch(e) { addLog('RECOVERY_SCHEDULE_ERR', `Erro agendando recuperação: ${e.message}`); }
        return;
    }

    conversation.stepIndex = nextStepIndex;
    if (reason === 'reply') { conversation.lastReply = new Date(); conversation.waiting_for_response = false; }
    conversations.set(phoneKey, conversation);
    addLog('STEP_NEXT', `➡️ Passo ${nextStepIndex + 1}/${funnel.steps.length}`, { phoneKey, reason });
    await sendStep(phoneKey);
}

// ============ MIDDLEWARES ============
// Preserva raw body em rotas de webhook para verificação HMAC
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
        if (req.url && req.url.startsWith('/webhook/')) {
            req.rawBody = buf;
        }
    }
}));
app.use(express.urlencoded({ extended: true }));

// Isolamento do domínio PIX — só permite /pix/:token nesse domínio (esconde admin do público)
const PIX_DOMAIN = process.env.PIX_DOMAIN || '';
app.use((req, res, next) => {
    if (PIX_DOMAIN && req.hostname === PIX_DOMAIN) {
        if (req.path.startsWith('/pix/')) return next();
        return res.status(404).send('Not found');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ============ HMAC HELPERS (verificação opcional de webhooks) ============
// Suporta múltiplos formatos de assinatura.
// ⭐ FIX 10/05: comportamento depende de WEBHOOK_HMAC_REQUIRED:
//   - WEBHOOK_HMAC_REQUIRED=1: secret é OBRIGATÓRIO, request sem assinatura válida é rejeitado
//   - default: se secret vazio, passa direto (compat); se secret setado, valida normalmente
function verifyWebhookHmac(req, secret, headerNames) {
    if (!secret) {
        if (WEBHOOK_HMAC_REQUIRED) return false; // fail-closed
        return true; // compat: sem secret configurado, passa
    }
    if (!req.rawBody) return false;
    try {
        const headers = headerNames || [];
        let providedSig = null;
        for (const h of headers) {
            const v = req.headers[h] || req.headers[h.toLowerCase()];
            if (v) { providedSig = String(v).replace(/^sha256=/i, '').trim(); break; }
        }
        if (!providedSig) return false;
        const computed = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        // Comparação timing-safe
        const a = Buffer.from(providedSig, 'utf8');
        const b = Buffer.from(computed, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch(e) {
        addLog('HMAC_ERR', `Erro verificando HMAC: ${e.message}`);
        return false;
    }
}

// ============ AUTH ============
function authMiddleware(req, res, next) {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false });
    try { jwt.verify(token, JWT_SECRET); next(); } catch { res.status(401).json({ success: false }); }
}

// Comparação timing-safe (evita timing attacks)
function timingSafeStringCompare(a, b) {
    try {
        const ab = Buffer.from(String(a || ''));
        const bb = Buffer.from(String(b || ''));
        if (ab.length !== bb.length) {
            // Mesmo comprimento, mas resultado falso — força mesmo tempo
            crypto.timingSafeEqual(ab, ab);
            return false;
        }
        return crypto.timingSafeEqual(ab, bb);
    } catch(e) { return false; }
}

// Verifica senha (suporta hash bcrypt OU plaintext, com fallback)
async function verifyPassword(plainPassword) {
    try {
        // Prioridade 1: hash bcrypt no env (mais seguro)
        if (ADMIN_PASSWORD_HASH && bcrypt) {
            return await bcrypt.compare(plainPassword, ADMIN_PASSWORD_HASH);
        }
        // Prioridade 2: comparação timing-safe com plaintext (fallback compatível com setup atual)
        if (ADMIN_PASSWORD) {
            return timingSafeStringCompare(plainPassword, ADMIN_PASSWORD);
        }
        return false;
    } catch(e) {
        addLog('AUTH_ERR', `Erro na verificação de senha: ${e.message}`);
        return false;
    }
}

// Rate limiter para login (gracefully degrade se lib não instalada)
const loginRateLimiter = rateLimit
    ? rateLimit({
        windowMs: 60 * 1000,        // 1 minuto
        max: 5,                      // 5 tentativas
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, message: 'Muitas tentativas. Aguarde 1 minuto.' },
        skipSuccessfulRequests: true
    })
    : (req, res, next) => next(); // se lib não instalada, passa direto

app.post('/auth/login', loginRateLimiter, async (req, res) => {
    try {
        const { login, password } = req.body || {};
        if (!login || !password) return res.status(400).json({ success: false, message: 'Login e senha obrigatórios' });
        const loginOk = timingSafeStringCompare(login, ADMIN_LOGIN);
        const passwordOk = await verifyPassword(password);
        if (loginOk && passwordOk) {
            res.json({ success: true, token: jwt.sign({ login }, JWT_SECRET, { expiresIn: '7d' }) });
        } else {
            // Pequeno delay aleatório pra dificultar enumeration
            await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
            res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
    } catch(e) {
        addLog('AUTH_LOGIN_ERR', e.message);
        res.status(500).json({ success: false, message: 'Erro interno' });
    }
});

// ============ SSE ============
app.get('/api/events-public', (req, res) => {
    const token = req.query.t;
    if (!token) return res.status(401).end();
    try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();
    sseClients.push(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients = sseClients.filter(c => c !== res); });
});

// ============ WHATSAPP CLOUD API OFICIAL — NÚCLEO DE ENVIO ============
// Toda mensagem enviada fica em wa_messages (status atualizado pelos webhooks da Meta:
// sent → delivered → read; failed com o erro; pricing diz se foi cobrada e a categoria).

async function waRequest(method, path, payload = null, token = null) {
    const url = `${GRAPH_BASE}/${path}`;
    const config = { method, url, headers: { Authorization: `Bearer ${token || WABA_TOKEN}` }, timeout: 30000 };
    if (payload) { config.data = payload; config.headers['Content-Type'] = 'application/json'; }
    const resp = await axios(config);
    return resp.data;
}

// Envia uma mensagem pelo número oficial. `message` é o objeto no formato da Meta
// (ex: { type:'text', text:{...} }). Retorna o wamid ou lança erro descritivo.
async function waSendMessage(to, message, meta = {}) {
    if (!isWabaConfigured()) throw new Error('API oficial não configurada (cadastre um número no painel ou WABA_TOKEN/WABA_PHONE_NUMBER_ID no ambiente)');
    const toPhone = String(to || '').replace(/\D/g, '');
    if (!toPhone) throw new Error('Destinatário inválido');
    // ⭐ 13/08: rotação — sem phoneNumberId explícito, escolhe pelo rodízio/sticky do cliente
    const phoneNumberId = meta.phoneNumberId || waPickSender(normalizePhoneKey(toPhone)) || WABA_PHONE_NUMBER_ID;
    const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: toPhone, ...message };
    try {
        const data = await waRequest('post', `${phoneNumberId}/messages`, payload, waTokenFor(phoneNumberId));
        const wamid = data?.messages?.[0]?.id || null;
        if (wamid) {
            try {
                db.getDb().prepare(`INSERT OR REPLACE INTO wa_messages
                    (wamid, phone_number_id, phone_key, to_phone, direction, msg_type, template_name, campaign_id, status)
                    VALUES (?, ?, ?, ?, 'out', ?, ?, ?, 'accepted')`)
                .run(wamid, phoneNumberId, normalizePhoneKey(toPhone), toPhone, message.type || 'text', meta.templateName || null, meta.campaignId || null);
            } catch(e) {}
        }
        return wamid;
    } catch (e) {
        const apiErr = e.response?.data?.error;
        let msg;
        if (apiErr) {
            const parts = [apiErr.message];
            if (apiErr.error_data?.details) parts.push(apiErr.error_data.details);
            if (apiErr.error_user_title) parts.push(apiErr.error_user_title);
            if (apiErr.error_user_msg) parts.push(apiErr.error_user_msg);
            msg = `${parts.join(' — ')} (código ${apiErr.code}${apiErr.error_subcode ? '/' + apiErr.error_subcode : ''})`;
        } else msg = e.message;
        addLog('WA_SEND_ERR', `❌ Envio oficial falhou pra ${toPhone}: ${msg}`);
        throw new Error(msg);
    }
}

// Construtores de mensagem (formato da Meta)
function waText(body) { return { type: 'text', text: { body: String(body || ''), preview_url: true } }; }
function waTemplate(name, lang = 'pt_BR', components = null) {
    const t = { type: 'template', template: { name, language: { code: lang } } };
    if (components) t.template.components = components;
    return t;
}
function waImage(link, caption) { return { type: 'image', image: caption ? { link, caption } : { link } }; }
function waVideo(link, caption) { return { type: 'video', video: caption ? { link, caption } : { link } }; }
function waAudio(link) { return { type: 'audio', audio: { link } }; }
// Botões de resposta rápida (até 3) — grátis dentro da janela. header opcional: vídeo/imagem em cima.
// Botão que abre um LINK (a Meta só permite 1 por mensagem)
function waCtaUrl(bodyText, buttonText, url, header = null, footerText = null) {
    const interactive = {
        type: 'cta_url',
        body: { text: String(bodyText || '') },
        action: { name: 'cta_url', parameters: { display_text: String(buttonText || 'Abrir').slice(0, 20), url: String(url) } }
    };
    if (header) interactive.header = header;
    if (footerText) interactive.footer = { text: String(footerText).slice(0, 60) };
    return { type: 'interactive', interactive };
}
function waButtons(bodyText, buttons, header = null, footerText = null) {
    const interactive = {
        type: 'button',
        body: { text: String(bodyText || '') },
        action: { buttons: (buttons || []).slice(0, 3).map((b, i) => ({ type: 'reply', reply: { id: String(b.id || ('btn' + (i + 1))), title: String(b.title || b).slice(0, 20) } })) }
    };
    if (header) interactive.header = header;
    if (footerText) interactive.footer = { text: String(footerText).slice(0, 60) };
    return { type: 'interactive', interactive };
}

// ===== Janela de 24h =====
function touchWaWindow(phoneKey, phone, referralJson = null, profileName = null) {
    try {
        db.getDb().prepare(`INSERT INTO wa_windows (phone_key, phone, last_inbound_at, last_referral_json, profile_name)
            VALUES (?, ?, datetime('now'), ?, ?)
            ON CONFLICT(phone_key) DO UPDATE SET phone = excluded.phone, last_inbound_at = datetime('now'),
                last_referral_json = COALESCE(excluded.last_referral_json, wa_windows.last_referral_json),
                profile_name = COALESCE(excluded.profile_name, wa_windows.profile_name)`)
        .run(phoneKey, phone, referralJson, profileName);
    } catch(e) {}
}
function isWaWindowOpen(phoneKey) {
    try {
        const row = db.getDb().prepare("SELECT 1 FROM wa_windows WHERE phone_key = ? AND datetime(last_inbound_at) > datetime('now', '-24 hours')").get(phoneKey);
        return !!row;
    } catch(e) { return false; }
}

// ===== Sincroniza os números da WABA (qualidade, limite e STATUS vêm da Meta) =====
// ⭐ 13/08: agora traz também o campo `status` (CONNECTED, BANNED, RESTRICTED, FLAGGED...).
// Antes um número BANIDO continuava aparecendo como "verde saudável" porque a Meta mantém a
// quality_rating antiga mesmo depois do banimento — o status é quem conta a verdade.
// ⭐ 14/08: sincroniza TODAS as contas (cada número do painel pode ser de uma BM diferente).
// Conta que dá erro na Meta (ex: WABA desativada por política) marca os números dela como
// CONTA_DESATIVADA — antes o erro passava batido e o número seguia "verde saudável".
async function waSyncNumbers() {
    const accounts = waAccounts();
    if (!accounts.length) throw new Error('Nenhuma conta configurada — cadastre um número no painel (com WABA ID e token)');
    const dbh = db.getDb();
    const up = dbh.prepare(`INSERT INTO official_numbers (phone_number_id, display_number, verified_name, quality_rating, messaging_limit, status, waba_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(phone_number_id) DO UPDATE SET display_number = excluded.display_number, verified_name = excluded.verified_name,
            quality_rating = excluded.quality_rating, messaging_limit = excluded.messaging_limit, status = excluded.status,
            waba_id = COALESCE(official_numbers.waba_id, excluded.waba_id), updated_at = datetime('now')`);
    const all = [];
    const errors = [];
    for (const acc of accounts) {
        let rows = [];
        try {
            // Checa a saúde da CONTA primeiro — WABA desativada derruba todos os números dela
            let contaRuim = null;
            try {
                const conta = await waRequest('get', `${acc.waba_id}?fields=id,account_review_status`, null, acc.token);
                const rev = String(conta?.account_review_status || '').toUpperCase();
                if (rev && !['APPROVED', 'PENDING'].includes(rev)) contaRuim = rev;
            } catch(e) { /* campo pode não existir em todas as contas — segue */ }
            const data = await waRequest('get', `${acc.waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`, null, acc.token);
            rows = data?.data || [];
            for (const n of rows) {
                const statusFinal = contaRuim ? ('CONTA_' + contaRuim) : (n.status || null);
                const prev = dbh.prepare('SELECT status FROM official_numbers WHERE phone_number_id = ?').get(n.id);
                up.run(n.id, n.display_phone_number || null, n.verified_name || null, n.quality_rating || null, n.messaging_limit_tier || null, statusFinal, acc.waba_id);
                const st = String(statusFinal || '').toUpperCase();
                if (st && st !== 'CONNECTED' && prev?.status !== statusFinal) {
                    addLog('WA_NUMBER_STATUS', `🚫 Número ${n.display_phone_number || n.id} está ${st} na Meta — fora da rotação de envio`, {});
                    try { await sendPushNotification('Número oficial com problema', `${n.display_phone_number || n.id} está ${st} na Meta. Ele saiu da rotação de envio — confira o painel.`, 'info'); } catch(e) {}
                }
            }
            all.push(...rows);
        } catch(e) {
            const msg = e.response?.data?.error?.message || e.message;
            errors.push(`WABA ${acc.waba_id}: ${msg}`);
            addLog('WA_SYNC_ERR', `⚠️ Sync falhou na WABA ${acc.waba_id}: ${msg}`);
            try { dbh.prepare("UPDATE official_numbers SET status = 'ERRO_NA_CONTA', updated_at = datetime('now') WHERE waba_id = ?").run(acc.waba_id); } catch(e2) {}
        }
    }
    if (!all.length && errors.length) throw new Error(errors.join(' · '));
    return all;
}

// ⭐ 13/08: sync automático a cada 30 min — banimento/queda de qualidade aparece sozinho
// no painel (e dispara push), sem depender de clicar em "Sincronizar com a Meta"
setInterval(() => {
    if (waAccounts().length) waSyncNumbers().catch(() => {});
}, 30 * 60 * 1000);

// ===== ⭐ 13/08: ROTAÇÃO DE NÚMEROS =====
// Regras: 1) cliente que já conversa com um número continua NELE (sticky — a resposta dele chega
// naquele número); 2) lead NOVO entra em rodízio (round-robin) entre os números saudáveis
// (active=1 e status CONNECTED); 3) número banido/restrito sai da rotação automaticamente.
function waHealthyNumbers() {
    try {
        // Sem token próprio o número só entra se existir token no ambiente (fallback legado)
        const tokenOk = WABA_TOKEN ? '1=1' : "(token IS NOT NULL AND token != '')";
        return db.getDb().prepare(`SELECT phone_number_id FROM official_numbers
            WHERE active = 1 AND (status IS NULL OR UPPER(status) = 'CONNECTED') AND ${tokenOk} ORDER BY phone_number_id`).all();
    } catch(e) { return []; }
}
function waBindSender(phoneKey, phoneNumberId) {
    if (!phoneKey || !phoneNumberId) return;
    try {
        db.getDb().prepare(`INSERT INTO wa_sender_map (phone_key, phone_number_id, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(phone_key) DO UPDATE SET phone_number_id = excluded.phone_number_id, updated_at = datetime('now')`)
        .run(phoneKey, phoneNumberId);
    } catch(e) {}
}
function waPickSender(phoneKey) {
    const healthy = waHealthyNumbers().map(r => r.phone_number_id);
    if (!healthy.length) return WABA_PHONE_NUMBER_ID; // sem sync ainda — usa o padrão do ambiente
    // Sticky: se o cliente já tem número atribuído e ele segue saudável, mantém
    if (phoneKey) {
        try {
            const cur = db.getDb().prepare('SELECT phone_number_id FROM wa_sender_map WHERE phone_key = ?').get(phoneKey);
            if (cur && healthy.includes(cur.phone_number_id)) return cur.phone_number_id;
        } catch(e) {}
    }
    // Rodízio: próximo número da fila
    let idx = parseInt(db.getSetting('WA_ROTATION_IDX') || '0');
    if (isNaN(idx) || idx < 0) idx = 0;
    const chosen = healthy[idx % healthy.length];
    try { db.setSetting('WA_ROTATION_IDX', String((idx + 1) % healthy.length)); } catch(e) {}
    if (phoneKey) waBindSender(phoneKey, chosen);
    return chosen;
}

// ============ WEBHOOK DA META (mensagens recebidas + status + qualidade) ============
// GET: verificação inicial da Meta (hub.challenge). POST: eventos.
app.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && META_WEBHOOK_VERIFY_TOKEN && token === META_WEBHOOK_VERIFY_TOKEN) {
        addLog('META_WEBHOOK', '✅ Webhook da Meta verificado com sucesso');
        return res.status(200).send(challenge);
    }
    res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
    res.sendStatus(200); // responde na hora — a Meta reenvia se demorar
    try {
        const entries = req.body?.entry || [];
        for (const entry of entries) {
            for (const change of (entry.changes || [])) {
                const field = change.field;
                const value = change.value || {};

                if (field === 'messages') {
                    // ----- Mensagens RECEBIDAS dos clientes -----
                    for (const msg of (value.messages || [])) {
                        const fromPhone = String(msg.from || '').replace(/\D/g, '');
                        const phoneKey = normalizePhoneKey(fromPhone);
                        if (!phoneKey) continue;
                        const contactName = value.contacts?.[0]?.profile?.name || '';
                        let text = '';
                        if (msg.type === 'text') text = msg.text?.body || '';
                        else if (msg.type === 'button') text = msg.button?.text || '';
                        else if (msg.type === 'interactive') text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
                        else if (['audio', 'image', 'video', 'document', 'sticker'].includes(msg.type)) {
                            // Guarda o ID da mídia — o chat busca o arquivo real via /api/wa/media/:id
                            const mediaId = msg[msg.type]?.id || '';
                            const caption = msg[msg.type]?.caption || '';
                            text = mediaId ? `[media:${msg.type}:${mediaId}]${caption ? ' ' + caption : ''}` : `[${msg.type.toUpperCase()}]`;
                        }
                        else text = `[${String(msg.type || 'mídia').toUpperCase()}]`;
                        const referral = msg.referral ? JSON.stringify(msg.referral) : null; // anúncio Click-to-WhatsApp

                        touchWaWindow(phoneKey, fromPhone, referral, contactName || null);
                        // ⭐ 13/08: cliente respondeu NESTE número — gruda ele aqui (rotação sticky)
                        try { waBindSender(phoneKey, value.metadata?.phone_number_id); } catch(e) {}
                        try {
                            db.getDb().prepare(`INSERT OR REPLACE INTO wa_messages (wamid, phone_number_id, phone_key, to_phone, direction, msg_type, status)
                                VALUES (?, ?, ?, ?, 'in', ?, 'received')`)
                            .run(msg.id || ('in_' + Date.now()), value.metadata?.phone_number_id || null, phoneKey, fromPhone, msg.type || 'text');
                        } catch(e) {}
                        try { db.logMessage(phoneKey, 'in', text, 'oficial', null, true); } catch(e) {}

                        addLog('WA_REPLY', `💬 ${contactName || fromPhone}: ${text.substring(0, 80)}${referral ? ' · veio de ANÚNCIO' : ''}`, { phoneKey });
                        sendSSE('client_reply', { phoneKey, customerName: contactName || fromPhone, message: text.substring(0, 120) });
                        // Opt-out imediato (política da Meta: opt-out fácil)
                        const lower = text.trim().toLowerCase();
                        if (['sair', 'parar', 'cancelar', 'stop', 'descadastrar'].includes(lower)) {
                            try { db.addToBlacklist(phoneKey, fromPhone, 'opt-out via mensagem (' + lower + ')'); } catch(e) {}
                            try { await waSendMessage(fromPhone, waText('Pronto! Você não vai mais receber mensagens nossas. Se mudar de ideia, é só mandar um oi. 👋')); } catch(e) {}
                            addLog('WA_OPTOUT', `🚫 ${fromPhone} pediu pra sair — blacklist`, { phoneKey });
                            continue;
                        }
                        if (db.isBlacklisted(phoneKey)) continue;

                        // ----- ⭐ 28/07: MOTOR DE FUNIS — a resposta do cliente move a conversa -----
                        const gotLock = await acquireWebhookLock(phoneKey);
                        if (!gotLock) continue;
                        try {
                            const conversation = findConversationUniversal(fromPhone);
                            if (!conversation || conversation.canceled || conversation.completed) {
                                // Reativação de lead antigo (mesma regra do canal anterior)
                                let handled = false;
                                const history = db.getCompletedConversationsByPhone(phoneKey);
                                if (history.length > 0) {
                                    const lastConv = history[0];
                                    const daysSince = (Date.now() - new Date(lastConv.created_at).getTime()) / 86400000;
                                    const reactivationDays = parseInt(db.getSetting('REACTIVATION_DAYS') || process.env.REACTIVATION_DAYS || '3');
                                    if (daysSince >= reactivationDays) {
                                        const reactivationFunnel = process.env.REACTIVATION_FUNNEL_ID || (lastConv.product_id + '_REATIVACAO');
                                        const reactivFunnel = db.getFunnelById(reactivationFunnel);
                                        if (reactivFunnel && reactivFunnel.steps?.length) {
                                            addLog('REACTIVATION', `♻️ Reativando lead antigo: ${phoneKey}`, { daysSince: Math.round(daysSince) });
                                            const reactivConv = {
                                                phoneKey, remoteJid: phoneToRemoteJid(fromPhone),
                                                funnelId: reactivationFunnel, stepIndex: 0,
                                                orderCode: 'REATIV_' + Date.now(),
                                                customerName: lastConv.customer_name,
                                                productId: lastConv.product_id, productName: lastConv.product_name,
                                                orderBumps: [], amount: 0, amountDisplay: '', netValue: 0,
                                                ddd: lastConv.ddd, city: lastConv.city, state: lastConv.state,
                                                waiting_for_response: false, createdAt: new Date(),
                                                canceled: false, completed: false, paused: false, reactivation: true, funnelType: 'REATIVACAO'
                                            };
                                            conversations.set(phoneKey, reactivConv);
                                            registerPhoneUniversal(fromPhone, phoneKey);
                                            await sendStep(phoneKey);
                                            handled = true;
                                        }
                                    }
                                }
                                // Gatilho de início (palavra-chave — lead novo, anúncio etc.)
                                if (!handled) {
                                    try {
                                        const startTrigger = checkStartTriggers(text, 'oficial');
                                        if (startTrigger) {
                                            const location = db.getLocationFromPhone(fromPhone);
                                            await startConversationFromTrigger(startTrigger, phoneKey, phoneToRemoteJid(fromPhone), location, 'oficial', contactName || null);
                                        }
                                    } catch(stErr) { addLog('START_TRIGGER_FAIL', `⚠️ Erro start_trigger: ${stErr.message}`); }
                                }
                            } else if (!conversation.pixWaiting && !conversation.paused && !conversation.invalidNumber) {
                                const freshConv = conversations.get(conversation.phoneKey) || conversation;
                                if (freshConv.waiting_for_response) {
                                    try { db.processWordFrequency(text, freshConv.productId); } catch(e) {}
                                    await advanceConversation(conversation.phoneKey, text, 'reply');
                                }
                            }
                        } finally { releaseWebhookLock(phoneKey); }
                    }

                    // ----- Status das mensagens ENVIADAS (sent/delivered/read/failed + cobrança) -----
                    for (const st of (value.statuses || [])) {
                        try {
                            const billable = st.pricing ? (st.pricing.billable ? 1 : 0) : null;
                            const category = st.pricing?.category || null;
                            const err = st.errors?.length ? JSON.stringify(st.errors[0]).substring(0, 300) : null;
                            db.getDb().prepare(`UPDATE wa_messages SET status = ?, billable = COALESCE(?, billable),
                                category = COALESCE(?, category), error = COALESCE(?, error), updated_at = datetime('now') WHERE wamid = ?`)
                            .run(st.status, billable, category, err, st.id);
                            if (st.status === 'failed') addLog('WA_FAILED', `❌ Mensagem oficial falhou pra ${st.recipient_id}: ${err || 'sem detalhe'}`);
                        } catch(e) {}
                    }
                }

                // ----- Qualidade do número mudou (verde/amarelo/vermelho) — avisa NA HORA -----
                if (field === 'phone_number_quality_update' || field === 'account_update') {
                    const ev = value.event || field;
                    const limit = value.current_limit || null;
                    addLog('WA_QUALITY', `⚠️ Atualização da Meta: ${ev}${limit ? ' · limite ' + limit : ''}`, {});
                    try { await sendPushNotification('Qualidade do número oficial', `Meta avisou: ${ev}${limit ? ' · limite atual ' + limit : ''}. Confira o painel.`, 'info'); } catch(e) {}
                    try { await waSyncNumbers(); } catch(e) {}
                }
            }
        }
    } catch (e) { addLog('META_WEBHOOK_ERR', e.message); }
});

// ============ API OFICIAL — ROTAS DO PAINEL ============
app.get('/api/wa/status', authMiddleware, async (req, res) => {
    try {
        let numbers = [];
        try { numbers = db.getDb().prepare('SELECT * FROM official_numbers ORDER BY created_at').all(); } catch(e) {}
        // Token NUNCA volta pro navegador — só a informação de que existe
        numbers = numbers.map(n => ({ ...n, token: undefined, has_token: !!n.token }));
        res.json({
            success: true,
            configured: isWabaConfigured(),
            has_waba_id: !!WABA_ID,
            has_verify_token: !!META_WEBHOOK_VERIFY_TOKEN,
            default_phone_number_id: WABA_PHONE_NUMBER_ID || null,
            graph_version: META_GRAPH_VERSION,
            numbers
        });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/wa/sync-numbers', authMiddleware, async (req, res) => {
    try { const rows = await waSyncNumbers(); res.json({ success: true, count: rows.length, numbers: rows }); }
    catch(e) { res.status(500).json({ success: false, error: e.response?.data?.error?.message || e.message }); }
});

// Lista os templates de TODAS as contas configuradas (⭐ 14/08: multi-BM)
app.get('/api/wa/templates', authMiddleware, async (req, res) => {
    try {
        const accounts = waAccounts();
        if (!accounts.length) return res.status(400).json({ success: false, error: 'Nenhuma conta configurada — cadastre um número no painel' });
        const templates = [];
        const errs = [];
        for (const acc of accounts) {
            try {
                const data = await waRequest('get', `${acc.waba_id}/message_templates?fields=name,status,category,language,components&limit=100`, null, acc.token);
                (data?.data || []).forEach(t => templates.push({ ...t, waba_id: acc.waba_id }));
            } catch(e) { errs.push(e.response?.data?.error?.message || e.message); }
        }
        if (!templates.length && errs.length) return res.status(500).json({ success: false, error: errs.join(' · ') });
        res.json({ success: true, templates });
    } catch(e) { res.status(500).json({ success: false, error: e.response?.data?.error?.message || e.message }); }
});

// ===== ⭐ 14/08: GESTÃO DE NÚMEROS PELO PAINEL (sem mexer no ambiente do EasyPanel) =====
// Adicionar: valida o token na hora buscando os dados do número direto na Meta
app.post('/api/wa/numbers', authMiddleware, async (req, res) => {
    try {
        const phoneNumberId = String(req.body?.phone_number_id || '').trim();
        const wabaId = String(req.body?.waba_id || '').trim();
        const token = String(req.body?.token || '').trim();
        const label = String(req.body?.label || '').trim() || null;
        if (!phoneNumberId || !wabaId || !token) return res.status(400).json({ success: false, error: 'Preencha Phone Number ID, WABA ID e Token' });
        // Valida o trio direto na Meta antes de salvar
        let info;
        try {
            info = await waRequest('get', `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,status`, null, token);
        } catch(e) {
            const msg = e.response?.data?.error?.message || e.message;
            return res.status(400).json({ success: false, error: 'A Meta recusou esses dados: ' + msg });
        }
        db.getDb().prepare(`INSERT INTO official_numbers (phone_number_id, display_number, verified_name, label, quality_rating, messaging_limit, status, waba_id, token, active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
            ON CONFLICT(phone_number_id) DO UPDATE SET display_number = excluded.display_number, verified_name = excluded.verified_name,
                label = COALESCE(excluded.label, official_numbers.label), quality_rating = excluded.quality_rating,
                messaging_limit = excluded.messaging_limit, status = excluded.status, waba_id = excluded.waba_id,
                token = excluded.token, active = 1, updated_at = datetime('now')`)
        .run(phoneNumberId, info.display_phone_number || null, info.verified_name || null, label,
             info.quality_rating || null, info.messaging_limit_tier || null, info.status || null, wabaId, token);
        addLog('WA_NUMBER_ADD', `➕ Número ${info.display_phone_number || phoneNumberId} cadastrado pelo painel (WABA ${wabaId})`);
        res.json({ success: true, number: { phone_number_id: phoneNumberId, display_number: info.display_phone_number, status: info.status } });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Excluir: some da rotação e da lista (clientes grudados nele são redistribuídos no próximo envio)
app.delete('/api/wa/numbers/:id', authMiddleware, (req, res) => {
    try {
        const id = String(req.params.id || '');
        const row = db.getDb().prepare('SELECT display_number FROM official_numbers WHERE phone_number_id = ?').get(id);
        db.getDb().prepare('DELETE FROM official_numbers WHERE phone_number_id = ?').run(id);
        try { db.getDb().prepare('DELETE FROM wa_sender_map WHERE phone_number_id = ?').run(id); } catch(e) {}
        addLog('WA_NUMBER_DEL', `🗑️ Número ${row?.display_number || id} removido do painel`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Ativar/desativar manualmente (desativado sai da rotação na hora, sem excluir)
app.post('/api/wa/numbers/:id/toggle', authMiddleware, (req, res) => {
    try {
        const id = String(req.params.id || '');
        const row = db.getDb().prepare('SELECT active, display_number FROM official_numbers WHERE phone_number_id = ?').get(id);
        if (!row) return res.status(404).json({ success: false, error: 'Número não encontrado' });
        const novo = row.active ? 0 : 1;
        db.getDb().prepare("UPDATE official_numbers SET active = ?, updated_at = datetime('now') WHERE phone_number_id = ?").run(novo, id);
        addLog('WA_NUMBER_TOGGLE', `${novo ? '▶️' : '⏸️'} Número ${row.display_number || id} ${novo ? 'ativado' : 'desativado'} manualmente`);
        res.json({ success: true, active: novo });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Proxy de mídia recebida: a Meta exige o token pra baixar — o chat usa esta rota.
// Token via query (?t=) porque <img>/<audio> não mandam header de autorização.
app.get('/api/wa/media/:id', async (req, res) => {
    try {
        const t = req.query.t || String(req.headers.authorization || '').replace('Bearer ', '');
        try { jwt.verify(t, JWT_SECRET); } catch { return res.status(401).end(); }
        // ⭐ 14/08: mídia pode ter chegado em qualquer conta — tenta o token de cada uma
        const tokens = [...new Set([WABA_TOKEN, ...waAccounts().map(a => a.token)].filter(Boolean))];
        let info = null, tokenUsado = null;
        for (const tk of tokens) {
            try { info = await waRequest('get', `${req.params.id}`, null, tk); tokenUsado = tk; break; } catch(e) {}
        }
        if (!info?.url) return res.status(404).end();
        const media = await axios.get(info.url, { headers: { Authorization: `Bearer ${tokenUsado}` }, responseType: 'stream', timeout: 30000 });
        res.setHeader('Content-Type', media.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        media.data.pipe(res);
    } catch(e) { res.status(500).end(); }
});

// ⭐ 29/07: testa um token AVULSO (não salva) — gere um novo na Meta e valide aqui antes do deploy.
app.post('/api/wa/test-token', authMiddleware, async (req, res) => {
    const tk = String(req.body?.token || '').trim();
    if (!tk) return res.status(400).json({ success: false, error: 'Cole o token' });
    const call = async (path) => {
        try {
            const r = await axios.get(`${GRAPH_BASE}/${path}`, { headers: { Authorization: `Bearer ${tk}` }, timeout: 20000 });
            return { ok: true, data: r.data };
        } catch(e) { return { ok: false, erro: e.response?.data || { message: e.message } }; }
    };
    const me = await call('me?fields=id,name');
    const numero = WABA_PHONE_NUMBER_ID ? await call(`${WABA_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,status,quality_rating,health_status`) : null;
    const conta = WABA_ID ? await call(`${WABA_ID}?fields=id,name,account_review_status,business_verification_status`) : null;
    res.json({ success: true, token_prefixo: tk.substring(0, 12) + '…' + tk.slice(-6) + ` (${tk.length} caracteres)`, me, numero, conta });
});

// ⭐ 29/07: SAÚDE NA META — pergunta pra própria Meta por que não dá pra enviar.
// health_status é o campo oficial que lista o que está bloqueando (verificação, review, pagamento...)
app.get('/api/wa/health', authMiddleware, async (req, res) => {
    const out = { success: true, erros: [] };
    try {
        if (!isWabaConfigured()) return res.json({ success: false, error: 'WABA_TOKEN / WABA_PHONE_NUMBER_ID não configurados' });
        const detalhe = (e) => {
            const err = e.response?.data?.error;
            if (!err) return e.message;
            const p = [err.message];
            if (err.type) p.push('tipo ' + err.type);
            if (err.code != null) p.push('código ' + err.code);
            if (err.error_subcode != null) p.push('subcódigo ' + err.error_subcode);
            if (err.error_data?.details) p.push(err.error_data.details);
            if (err.error_user_title) p.push(err.error_user_title);
            if (err.error_user_msg) p.push(err.error_user_msg);
            if (err.fbtrace_id) p.push('fbtrace ' + err.fbtrace_id);
            return p.join(' · ');
        };
        try {
            out.numero = await waRequest('get', `${WABA_PHONE_NUMBER_ID}?fields=verified_name,display_phone_number,quality_rating,code_verification_status,name_status,status,platform_type,messaging_limit_tier,health_status`);
        } catch(e) { out.erros.push('Número: ' + detalhe(e)); out.erro_bruto_numero = e.response?.data || null; }
        if (WABA_ID) {
            try {
                out.conta = await waRequest('get', `${WABA_ID}?fields=id,name,account_review_status,business_verification_status,country,currency,timezone_id,health_status`);
            } catch(e) { out.erros.push('Conta (WABA): ' + detalhe(e)); out.erro_bruto_conta = e.response?.data || null; }
        }
        try {
            out.token = await waRequest('get', 'me?fields=id,name');
        } catch(e) { out.erros.push('Token: ' + detalhe(e)); out.erro_bruto_token = e.response?.data || null; }
        out.token_prefixo = WABA_TOKEN ? (WABA_TOKEN.substring(0, 12) + '…' + WABA_TOKEN.slice(-6) + ` (${WABA_TOKEN.length} caracteres)`) : 'ausente';
        // Interpretação amigável
        const hs = out.numero?.health_status || out.conta?.health_status;
        const dicas = [];
        if (hs) {
            if (hs.can_send_message === 'AVAILABLE') dicas.push('✅ A Meta diz que ESTE número PODE enviar mensagens agora.');
            else if (hs.can_send_message === 'LIMITED') dicas.push('⚠️ Envio LIMITADO — veja os motivos abaixo.');
            else dicas.push('❌ A Meta diz que o envio está BLOQUEADO — veja os motivos abaixo.');
            for (const ent of (hs.entities || [])) {
                if (ent.can_send_message && ent.can_send_message !== 'AVAILABLE') {
                    const nome = { PHONE_NUMBER: 'Número', WABA: 'Conta WhatsApp Business', BUSINESS: 'Empresa (portfólio)', APP: 'App', TEMPLATE: 'Template' }[ent.entity_type] || ent.entity_type;
                    for (const err of (ent.errors || [])) {
                        dicas.push(`• ${nome}: ${err.error_description || err.error_code}${err.possible_solution ? ' → SOLUÇÃO: ' + err.possible_solution : ''}`);
                    }
                    if (!(ent.errors || []).length) dicas.push(`• ${nome}: ${ent.can_send_message}`);
                }
            }
        }
        if (out.conta?.account_review_status && out.conta.account_review_status !== 'APPROVED') dicas.push(`⚠️ Análise da conta: ${out.conta.account_review_status}`);
        if (out.conta?.business_verification_status && out.conta.business_verification_status !== 'verified') dicas.push(`ℹ️ Verificação da empresa: ${out.conta.business_verification_status} (limita volume, mas não deveria bloquear)`);
        if (out.numero?.status && out.numero.status !== 'CONNECTED') dicas.push(`⚠️ Status do número: ${out.numero.status}`);
        if (out.numero?.name_status && !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(out.numero.name_status)) dicas.push(`ℹ️ Nome de exibição: ${out.numero.name_status}`);
        out.resumo = dicas;
        res.json(out);
    } catch(e) { res.status(500).json({ success: false, error: e.message, parcial: out }); }
});

// ============ DIAGNÓSTICO DO CANAL (responde "por que não aconteceu nada?") ============
app.get('/api/wa/diagnose', authMiddleware, (req, res) => {
    try {
        const dbi = db.getDb();
        const lastIn = dbi.prepare("SELECT phone_key, to_phone, created_at FROM wa_messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1").get();
        const lastOut = dbi.prepare("SELECT to_phone, msg_type, status, created_at FROM wa_messages WHERE direction='out' ORDER BY created_at DESC LIMIT 1").get();
        const windows = dbi.prepare("SELECT phone, phone_key, last_inbound_at, (CASE WHEN datetime(last_inbound_at) > datetime('now','-24 hours') THEN 1 ELSE 0 END) AS aberta FROM wa_windows ORDER BY last_inbound_at DESC LIMIT 5").all();
        const startTriggers = db.getActiveStartTriggers().map(t => ({
            name: t.name, keywords: t.keywords, match_type: t.match_type,
            funnel: t.target_funnel_id,
            funnel_ok: (() => { const f = db.getFunnelById(t.target_funnel_id); return !!(f && f.steps && f.steps.length); })(),
            instances_filter: t.instances || '[]'
        }));
        const funnels = db.getFunnels().map(f => ({ id: f.id, type: f.type, product: f.product_id, steps: (f.steps || []).length }));
        const recentLogs = logs.filter(l => /WA_|START_TRIGGER|STEP_|SEND_|AUTO_SEND|FUNNEL_/.test(l.type)).slice(0, 25)
            .map(l => ({ type: l.type, message: String(l.message).substring(0, 160), at: l.timestamp || l.time }));
        res.json({
            success: true,
            canal: { configurado: isWabaConfigured(), waba_id: !!WABA_ID, verify_token: !!META_WEBHOOK_VERIFY_TOKEN },
            envio_automatico: isAutoSendEnabled(),
            ultima_mensagem_recebida: lastIn || null,
            ultima_mensagem_enviada: lastOut || null,
            janelas: windows,
            gatilhos_de_inicio: startTriggers,
            funis: funnels,
            blacklist_total: (dbi.prepare('SELECT COUNT(*) c FROM blacklist').get() || {}).c || 0,
            logs_recentes: recentLogs
        });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ 29/07: SIMULA uma mensagem recebida — roda o pipeline REAL (gatilhos, funis, janela).
// Use com o SEU número pra ver o funil chegando no seu WhatsApp antes de expor a clientes.
app.post('/api/wa/simulate-inbound', authMiddleware, async (req, res) => {
    try {
        const phoneRaw = String(req.body?.phone || '').replace(/\D/g, '');
        const text = String(req.body?.text || '').trim();
        if (!phoneRaw || !text) return res.status(400).json({ success: false, error: 'Informe phone e text' });
        const fromPhone = normalizeFullPhone(phoneRaw);
        const phoneKey = normalizePhoneKey(phoneRaw);
        if (!phoneKey || phoneKey.length !== 8) return res.status(400).json({ success: false, error: 'Telefone inválido' });

        const trace = [];
        trace.push(`Telefone: ${fromPhone} (chave ${phoneKey})`);
        if (db.isBlacklisted(phoneKey)) return res.json({ success: false, error: 'Esse número está na BLACKLIST — remova antes de testar', trace });

        touchWaWindow(phoneKey, fromPhone, null, req.body?.name || 'Teste Simulado');
        db.logMessage(phoneKey, 'in', text, 'oficial', null, true);
        trace.push('Janela de 24h aberta + mensagem registrada no Chat');

        const existing = findConversationUniversal(fromPhone);
        if (existing && !existing.canceled && !existing.completed) {
            trace.push(`Já existe conversa ATIVA (funil ${existing.funnelId}, passo ${(existing.stepIndex||0)+1}) — a resposta vai AVANÇAR esse funil`);
            if (existing.waiting_for_response) { await advanceConversation(existing.phoneKey, text, 'reply'); trace.push('advanceConversation executado'); }
            else trace.push('Conversa não estava aguardando resposta — nada avançou (é o comportamento normal)');
            return res.json({ success: true, trace });
        }

        const dbg = checkStartTriggers(text, 'oficial', true);
        (dbg.reasons || []).forEach(r => trace.push('Gatilho: ' + r));
        if (!dbg.trigger) {
            trace.push('❌ Nenhum gatilho de início bateu — o lead não entraria em funil nenhum');
            return res.json({ success: true, matched: false, trace });
        }
        const funnel = db.getFunnelById(dbg.trigger.target_funnel_id);
        if (!funnel || !(funnel.steps || []).length) {
            trace.push(`❌ Gatilho aponta pro funil "${dbg.trigger.target_funnel_id}" que está VAZIO ou não existe`);
            return res.json({ success: true, matched: true, trace });
        }
        trace.push(`✅ Gatilho "${dbg.trigger.name}" → funil ${funnel.id} (${funnel.steps.length} passos). Disparando...`);
        const location = db.getLocationFromPhone(fromPhone);
        const started = await startConversationFromTrigger(dbg.trigger, phoneKey, phoneToRemoteJid(fromPhone), location, 'oficial', req.body?.name || null);
        trace.push(started ? '✅ Funil iniciado — confira seu WhatsApp e a aba Chat' : '❌ startConversationFromTrigger retornou falso (veja os logs)');
        res.json({ success: true, matched: true, started, trace });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ CAIXA DE CONVERSAS (o "WhatsApp Web" da Orion) ============
// Números oficiais não têm app nem Web — toda conversa vive aqui.
app.get('/api/wa/chats', authMiddleware, (req, res) => {
    try {
        const rows = db.getDb().prepare(`
            SELECT m.phone_key,
                   MAX(m.created_at) AS last_at,
                   (SELECT content FROM messages_log m2 WHERE m2.phone_key = m.phone_key AND m2.instance = 'oficial' ORDER BY m2.created_at DESC, m2.id DESC LIMIT 1) AS last_content,
                   (SELECT direction FROM messages_log m3 WHERE m3.phone_key = m.phone_key AND m3.instance = 'oficial' ORDER BY m3.created_at DESC, m3.id DESC LIMIT 1) AS last_direction
            FROM messages_log m
            WHERE m.instance = 'oficial' AND datetime(m.created_at) >= datetime('now', '-30 days')
            GROUP BY m.phone_key
            ORDER BY last_at DESC LIMIT 100`).all();
        const nameStmt = db.getDb().prepare('SELECT customer_name, customer_phone FROM events WHERE phone_key = ? AND customer_name IS NOT NULL ORDER BY id DESC LIMIT 1');
        const winStmt = db.getDb().prepare('SELECT phone, last_inbound_at, profile_name FROM wa_windows WHERE phone_key = ?');
        const chats = rows.map(r => {
            const ev = nameStmt.get(r.phone_key) || {};
            const win = winStmt.get(r.phone_key) || {};
            const conv = conversations.get(r.phone_key);
            const windowOpen = win.last_inbound_at ? (Date.now() - new Date(win.last_inbound_at.replace(' ', 'T') + 'Z').getTime()) < 24 * 60 * 60 * 1000 : false;
            const windowHoursLeft = windowOpen ? Math.max(0, 24 - (Date.now() - new Date(win.last_inbound_at.replace(' ', 'T') + 'Z').getTime()) / 3600000) : 0;
            return {
                phone_key: r.phone_key,
                phone: win.phone || ev.customer_phone || jidToPhone(conv?.remoteJid) || null,
                name: conv?.customerName || ev.customer_name || win.profile_name || win.phone || r.phone_key,
                last_at: r.last_at,
                last_content: (r.last_content || '').substring(0, 80),
                last_direction: r.last_direction,
                window_open: windowOpen,
                window_hours_left: Math.round(windowHoursLeft * 10) / 10,
                funnel_type: conv && !conv.canceled && !conv.completed ? conv.funnelType : null
            };
        });
        res.json({ success: true, data: chats });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/wa/chats/:phoneKey', authMiddleware, (req, res) => {
    try {
        const phoneKey = req.params.phoneKey;
        const msgs = db.getDb().prepare(`SELECT direction, content, instance, created_at FROM messages_log
            WHERE phone_key = ? AND instance = 'oficial' ORDER BY created_at ASC, id ASC LIMIT 300`).all(phoneKey);
        const win = db.getDb().prepare('SELECT phone, last_inbound_at, profile_name FROM wa_windows WHERE phone_key = ?').get(phoneKey) || {};
        const ev = db.getDb().prepare('SELECT customer_name, customer_phone FROM events WHERE phone_key = ? AND customer_name IS NOT NULL ORDER BY id DESC LIMIT 1').get(phoneKey) || {};
        const conv = conversations.get(phoneKey);
        const windowOpen = win.last_inbound_at ? (Date.now() - new Date(win.last_inbound_at.replace(' ', 'T') + 'Z').getTime()) < 24 * 60 * 60 * 1000 : false;
        res.json({
            success: true,
            name: conv?.customerName || ev.customer_name || win.profile_name || win.phone || phoneKey,
            phone: win.phone || ev.customer_phone || jidToPhone(conv?.remoteJid) || null,
            window_open: windowOpen,
            window_hours_left: windowOpen ? Math.round(Math.max(0, 24 - (Date.now() - new Date(win.last_inbound_at.replace(' ', 'T') + 'Z').getTime()) / 3600000) * 10) / 10 : 0,
            messages: msgs
        });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Resposta manual pelo painel (só com janela aberta — igual atendimento humano)
app.post('/api/wa/chats/:phoneKey/send', authMiddleware, async (req, res) => {
    try {
        const phoneKey = req.params.phoneKey;
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ success: false, error: 'Mensagem vazia' });
        const win = db.getDb().prepare('SELECT phone FROM wa_windows WHERE phone_key = ?').get(phoneKey);
        const ev = db.getDb().prepare('SELECT customer_phone FROM events WHERE phone_key = ? AND customer_phone IS NOT NULL ORDER BY id DESC LIMIT 1').get(phoneKey);
        const phone = win?.phone || ev?.customer_phone;
        if (!phone) return res.status(400).json({ success: false, error: 'Telefone completo desconhecido pra esse cliente' });
        if (!isWaWindowOpen(phoneKey)) return res.status(400).json({ success: false, error: 'Janela de 24h fechada — o cliente precisa mandar mensagem primeiro (ou use um template)' });
        await waSendMessage(phone, waText(text));
        db.logMessage(phoneKey, 'out', text, 'oficial', null, true);
        addLog('WA_MANUAL_REPLY', `💬 Resposta manual pra ${phone}: ${text.substring(0, 60)}`, { phoneKey });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ 29/07: cria os FUNIS MODELO do canal oficial já montados (o operador só preenche textos/URLs).
// Idempotente: funil que já existe com passos não é sobrescrito.
app.post('/api/funnels/seed-models', authMiddleware, (req, res) => {
    try {
        const tplAprovada = String(req.body?.template_aprovada || 'aprovada').trim();
        const tplPix = String(req.body?.template_pix || tplAprovada).trim();
        const models = [
            {
                id: 'GLOBAL_APROVADA', product_id: 'GLOBAL', type: 'APROVADA', name: '🌐 Venda aprovada (todos os produtos)',
                steps: [
                    { id: 'ga1', type: 'template', templateName: tplAprovada, templateLang: 'pt_BR', templateParams: 'nome={NOME}', waitForReply: true, text: '' },
                    { id: 'ga2', type: 'text', text: 'Prontinho {NOME}! 😊 Seu acesso já está liberado no app:\n\nhttps://m.membrosvips.com\n\nÉ só entrar com o e-mail da compra: {EMAIL}', waitForReply: false, delayBefore: 0 },
                    { id: 'ga3', type: 'text', text: '[EDITE ESTA MENSAGEM — oferta 1]', waitForReply: false, delayBefore: 300 },
                    { id: 'ga4', type: 'text', text: '[EDITE ESTA MENSAGEM — oferta 2]', waitForReply: false, delayBefore: 900 }
                ]
            },
            {
                id: 'GLOBAL_PIX', product_id: 'GLOBAL', type: 'PIX', name: '🌐 PIX gerado (todos os produtos)',
                steps: [
                    { id: 'gp1', type: 'template', templateName: tplPix, templateLang: 'pt_BR', templateParams: 'nome={NOME}', waitForReply: true, text: '' },
                    { id: 'gp2', type: 'audio', mediaUrl: '', text: '', waitForReply: false, delayBefore: 3 },
                    { id: 'gp3', type: 'text', text: 'Aqui está, {NOME} 😉\n\n{PIX_LINK}\n\nÉ só tocar no botão verde pra copiar o código e pagar no app do seu banco. Qualquer coisa me chama aqui!', waitForReply: false, delayBefore: 5 },
                    { id: 'gp4', type: 'text', text: '[EDITE — oferta com desconto se ele não pagar]', waitForReply: false, delayBefore: 600 }
                ]
            },
            {
                id: 'GLOBAL_ATENDIMENTO', product_id: 'GLOBAL', type: 'DIRETO', name: '🌐 Atendimento (lead do anúncio)',
                steps: [
                    { id: 'gt1', type: 'audio', mediaUrl: '', text: '', waitForReply: false, delayBefore: 2 },
                    { id: 'gt2', type: 'buttons', mediaUrl: '', text: 'NOSSO APLICATIVO COMPLETO PRA VOCÊ!\n\nESCOLHA O QUE VOCÊ MAIS TEM INTERESSE 👇', footerText: 'Clique em um dos botões', buttonsText: 'CONVERSAS\nGRUPOS\nCHAMADAS DE VÍDEO', waitForReply: true, delayBefore: 3 }
                ]
            },
            { id: 'GLOBAL_OPCAO_CONVERSAS', product_id: 'GLOBAL', type: 'DIRETO', name: '🌐 Escolha: CONVERSAS', steps: [
                { id: 'oc1', type: 'text', text: '[EDITE — link/explicação de CONVERSAS]', waitForReply: false },
                { id: 'oc2', type: 'text', text: '[EDITE — oferta/pergunta final]', waitForReply: false, delayBefore: 3600 } ] },
            { id: 'GLOBAL_OPCAO_GRUPOS', product_id: 'GLOBAL', type: 'DIRETO', name: '🌐 Escolha: GRUPOS', steps: [
                { id: 'og1', type: 'text', text: '[EDITE — link/explicação de GRUPOS]', waitForReply: false },
                { id: 'og2', type: 'text', text: '[EDITE — oferta/pergunta final]', waitForReply: false, delayBefore: 3600 } ] },
            { id: 'GLOBAL_OPCAO_CHAMADAS', product_id: 'GLOBAL', type: 'DIRETO', name: '🌐 Escolha: CHAMADAS DE VÍDEO', steps: [
                { id: 'ov1', type: 'text', text: '[EDITE — link/explicação de CHAMADAS DE VÍDEO]', waitForReply: false },
                { id: 'ov2', type: 'text', text: '[EDITE — oferta/pergunta final]', waitForReply: false, delayBefore: 3600 } ] }
        ];
        const created = [], skipped = [];
        for (const m of models) {
            const existing = db.getFunnelById(m.id);
            if (existing && Array.isArray(existing.steps) && existing.steps.length) { skipped.push(m.id); continue; }
            db.saveFunnel(m);
            created.push(m.id);
        }
        // Gatilhos que ligam o clique do botão ao mini-funil da escolha
        const triggers = [
            { name: 'Botão CONVERSAS', keywords: 'CONVERSAS', target_funnel_id: 'GLOBAL_OPCAO_CONVERSAS' },
            { name: 'Botão GRUPOS', keywords: 'GRUPOS', target_funnel_id: 'GLOBAL_OPCAO_GRUPOS' },
            { name: 'Botão CHAMADAS', keywords: 'CHAMADAS', target_funnel_id: 'GLOBAL_OPCAO_CHAMADAS' }
        ];
        let trigCreated = 0;
        const existingTrigs = db.getTriggers();
        for (const t of triggers) {
            if (existingTrigs.some(x => x.name === t.name)) continue;
            db.saveTrigger({ name: t.name, keywords: t.keywords, match_type: 'contains', target_funnel_id: t.target_funnel_id, auto_block: 0, active: 1 });
            trigCreated++;
        }
        addLog('FUNNELS_SEEDED', `🌱 Funis modelo criados: ${created.join(', ') || 'nenhum novo'} · ${trigCreated} gatilhos`);
        res.json({ success: true, created, skipped, triggers_created: trigCreated });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ 28/07: apagar todos os funis (recomeço limpo pra era da API oficial). Exige confirmação exata.
app.post('/api/funnels/delete-all', authMiddleware, (req, res) => {
    try {
        if (req.body?.confirm !== 'APAGAR FUNIS') return res.status(400).json({ success: false, error: 'Confirmação obrigatória' });
        const n = db.getDb().prepare('DELETE FROM funnels').run().changes;
        addLog('FUNNELS_WIPED', `🗑️ ${n} funis apagados — recomeço limpo pro canal oficial`);
        res.json({ success: true, deleted: n });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ 28/07: registro do número direto pela API (a tela da Meta às vezes falha; este é o método canônico).
// Define o PIN de verificação em 2 etapas no ato. Requer WABA_TOKEN + WABA_PHONE_NUMBER_ID.
app.post('/api/wa/register', authMiddleware, async (req, res) => {
    try {
        const pin = String(req.body?.pin || '').replace(/\D/g, '');
        if (pin.length !== 6) return res.status(400).json({ success: false, error: 'PIN precisa ter exatamente 6 dígitos' });
        if (!isWabaConfigured()) return res.status(400).json({ success: false, error: 'WABA_TOKEN / WABA_PHONE_NUMBER_ID não configurados' });
        const data = await waRequest('post', `${WABA_PHONE_NUMBER_ID}/register`, { messaging_product: 'whatsapp', pin });
        addLog('WA_REGISTER', `✅ Número oficial REGISTRADO na API (PIN definido)`);
        try { await waSyncNumbers(); } catch(e) {}
        res.json({ success: true, data });
    } catch(e) {
        const apiErr = e.response?.data?.error;
        const msg = apiErr ? `${apiErr.message}${apiErr.error_data?.details ? ' — ' + apiErr.error_data.details : ''} (código ${apiErr.code})` : e.message;
        addLog('WA_REGISTER_ERR', `❌ Registro falhou: ${msg}`);
        res.status(500).json({ success: false, error: msg });
    }
});

// Envio de teste (texto livre exige janela aberta; template funciona sempre)
app.post('/api/wa/test-send', authMiddleware, async (req, res) => {
    try {
        const { to, text, template_name, template_lang, template_params } = req.body || {};
        if (!to) return res.status(400).json({ success: false, error: 'Informe o número de destino (to)' });
        let wamid;
        if (template_name) {
            let components = null;
            const raw = Array.isArray(template_params) ? template_params.map(p => String(p).trim()).filter(Boolean) : [];
            const parsed = raw.map(s => {
                const eq = s.indexOf('=');
                if (eq > 0 && /^[a-z0-9_]+$/.test(s.slice(0, eq).trim())) return { name: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() };
                return { name: null, value: s };
            });
            if (parsed.length) {
                const named = parsed.some(p => p.name);
                components = [{ type: 'body', parameters: parsed.map(p => named
                    ? { type: 'text', parameter_name: p.name || '', text: p.value }
                    : { type: 'text', text: p.value }) }];
            }
            wamid = await waSendMessage(to, waTemplate(template_name, template_lang || 'pt_BR', components), { templateName: template_name });
        }
        else if (text) wamid = await waSendMessage(to, waText(text));
        else return res.status(400).json({ success: false, error: 'Informe text ou template_name' });
        addLog('WA_TEST', `🧪 Teste oficial enviado pra ${to} (${template_name || 'texto'})`);
        res.json({ success: true, wamid });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ WEBHOOKS ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        // HMAC opcional (só verifica se KIRVANO_WEBHOOK_SECRET estiver definido)
        if (KIRVANO_WEBHOOK_SECRET) {
            const ok = verifyWebhookHmac(req, KIRVANO_WEBHOOK_SECRET, ['x-kirvano-signature', 'x-signature', 'x-webhook-signature']);
            if (!ok) {
                addLog('KIRVANO_HMAC_FAIL', '🚫 HMAC inválido — webhook rejeitado');
                return res.status(401).json({ success: false, message: 'invalid signature' });
            }
        }
        const data = req.body;
        const event = String(data.event || '').toUpperCase();
        const status = String(data.status || '').toUpperCase();
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        const orderCode = data.sale_id || data.checkout_id || 'ORDER_' + Date.now();
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const pixCode = data.payment?.qrcode || data.payment?.pix_url || data.payment?.pix_code || data.payment?.payment_url || data.payment?.checkout_url || null;
        const pixExpiresAt = data.payment?.expires_at || null;
        const orderBumps = (data.products || []).filter(p => p.is_order_bump).map(p => p.name);
        // Lista completa de produtos pra resumo do pedido na página PIX (principal primeiro)
        const productsForSummary = extractProductsForSummary(data.products);
        const mainProduct = (data.products || []).find(p => !p.is_order_bump) || null;
        const mainOfferId = mainProduct?.offer_id;
        const productDb = mainOfferId ? db.getProductByOfferId(mainOfferId) : null;
        const productId = productDb?.id || 'GRUPO_VIP';
        // ⭐ 22/07: produto não cadastrado usa o NOME REAL vindo do webhook (antes tudo virava "GRUPO VIP")
        const productName = productDb?.name || mainProduct?.name || 'GRUPO VIP';

        // VALOR BRUTO: o que o cliente pagou (fiscal.total_value é o mais confiável)
        const amount = parseFloat(data.fiscal?.total_value) ||
                       parseFloat(String(data.total_price || '0').replace(/[^0-9,.]/g, '').replace(',', '.')) ||
                       0;
        // VALOR LÍQUIDO: o que cai pra você (fiscal.commission é o campo correto, confirmado no payload real)
        // ATENÇÃO: data.fiscal.net_value é ENGANOSO (Kirvano coloca o bruto lá). Usar SEMPRE fiscal.commission.
        // Tratamos null/undefined/string vazia como ausente (mas 0 é valor válido — afiliado sem comissão)
        const parseFinanceField = (val) => {
            if (val === null || val === undefined || val === '') return null;
            const n = parseFloat(val);
            return isNaN(n) ? null : n;
        };
        const netValue =
            parseFinanceField(data.fiscal?.commission) ??
            parseFinanceField(data.commission) ??
            parseFinanceField(data.fiscal?.total_commissions) ??
            amount;
        // UTMs do Facebook Ads (vazio quando o anúncio não passa as tags)
        const utmSource = data.utm?.utm_source || null;
        const utmCampaign = data.utm?.utm_campaign || null;
        const utmMedium = data.utm?.utm_medium || null;
        const utmContent = data.utm?.utm_content || null;
        const utmTerm = data.utm?.utm_term || null;
        const customerEmail = data.customer?.email || null;
        const customerDocument = data.customer?.document || null;

        // Auditoria: grava o payload completo (pra ROI por campanha, replay, debug)
        try {
            db.logWebhook({
                gateway: 'kirvano',
                event: event,
                sale_id: data.sale_id || data.checkout_id || null,
                phone_key: null,
                customer_email: customerEmail,
                customer_document: customerDocument,
                utm_source: utmSource,
                utm_campaign: utmCampaign,
                utm_medium: utmMedium,
                utm_content: utmContent,
                utm_term: utmTerm,
                amount_gross: amount,
                amount_net: netValue,
                payload_json: JSON.stringify(data)
            });
        } catch(e) { /* nunca deve quebrar fluxo de venda */ }

        const isCard = method.includes('CREDIT') || method.includes('CARD');
        const paymentMethod = isCard ? 'CREDIT_CARD' : 'PIX';
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');

        const phoneKey = normalizePhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) return res.json({ success: false, message: 'Telefone inválido' });
        if (db.isBlacklisted(phoneKey)) { addLog('BLACKLIST_BLOCK', `🚫 Bloqueado: ${phoneKey}`); return res.json({ success: true, message: 'Blacklisted' }); }

        // ⭐ FIX 04/05: Lock pra evitar 2 webhooks simultâneos (gateway retenta, cliente paga 2 PIXs em paralelo).
        // Sem isso: 2 PIX_GENERATED pelo mesmo phoneKey criam 2 conversas/timers; APROVADA + PIX simultâneos viram race.
        // Retorna 503 pra Kirvano retentar — mensagem não é perdida em silêncio.
        const hasLock = await acquireWebhookLock(phoneKey, 30000);
        if (!hasLock) { addLog('KIRVANO_LOCKED', `🔒 Lock timeout para ${phoneKey} — pedindo retry`); return res.status(503).json({ success: false, message: 'busy, retry' }); }

        try {
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhoneUniversal(customerPhone, phoneKey);
        const location = db.getLocationFromPhone(customerPhone);

        addLog('KIRVANO', `${event} — ${customerName} · Bruto R$${amount.toFixed(2)} · Líquido R$${netValue.toFixed(2)}`, { orderCode, phoneKey, productId });

        const isAbandoned = event.includes('ABANDON') || status === 'ABANDONED' || event === 'CHECKOUT_ABANDONED';
        const isRefused = event.includes('REFUSED') || event.includes('DECLINED') || event.includes('FAILED') || status === 'REFUSED' || status === 'DECLINED' || status === 'FAILED';
        // ⭐ 22/07: reembolso/estorno/chargeback (antes eram ignorados em silêncio)
        const isRefunded = event.includes('REFUND') || event.includes('CHARGEBACK') || event.includes('CHARGEDBACK') ||
                           status === 'REFUNDED' || status === 'CHARGEBACK' || status === 'CHARGEDBACK';

        // Relay pro LinkRotator (fire-and-forget — não atrasa nem trava o webhook)
        const relayPayload = {
            ref: utmContent || data.utm_content || data.customer?.utm_content || null,
            sale_id: orderCode,
            order_code: orderCode,
            customer_phone: customerPhone,
            customer_name: customerName,
            customer_email: customerEmail,
            amount_gross: amount,
            amount_net: netValue,
            product_name: productName,
            payment_method: paymentMethod,
            utm_source: utmSource,
            utm_campaign: utmCampaign
        };

        if (isRefunded) {
            // ⭐ 22/07: reembolso — cancela funil/timers ativos, registra evento e notifica
            const existingConv = findConversationUniversal(customerPhone);
            const convKey = existingConv?.phoneKey || phoneKey;
            for (const k of new Set([phoneKey, convKey])) {
                const pt = pixTimeouts.get(k); if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(k); try { db.deletePixTimeout(k); } catch(e) {} }
            }
            if (existingConv && !existingConv.canceled && !existingConv.completed) {
                existingConv.canceled = true; existingConv.canceledAt = new Date(); existingConv.cancelReason = 'reembolso';
                conversations.set(convKey, existingConv);
                try { convToDb(convKey, existingConv); } catch(e) {}
                bumpEpoch(convKey); // mata o loop do funil na hora
            }
            try { db.cancelScheduledFunnelsByPhone(phoneKey, 'reembolso'); } catch(e) {}
            db.recordEvent('REFUNDED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod, order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: normalizeFullPhone(customerPhone) });
            addLog('REFUNDED', `↩️ Reembolso: ${customerName} · R$${(netValue || amount || 0).toFixed(2)}`, { orderCode, phoneKey });
            {
                const notif = buildPaymentNotification('refund', customerName, netValue || amount, productName);
                await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
            }
        } else if (isApproved) {
            const existingConv = findConversationUniversal(customerPhone);
            // ⭐ FIX 06/26: usa a chave REAL da conversa encontrada (pode viver sob outra variação do número)
            const convKey = existingConv?.phoneKey || phoneKey;
            // ⭐ FIX 06/26: detecção por ESTADO da conversa, não pelo nome do funil — funil A/B com id
            // personalizado (sem '_PIX' no nome) caía no caminho errado e o cancelamento podia falhar.
            const isPixConv = existingConv && !existingConv.canceled && !existingConv.completed &&
                (existingConv.pixWaiting || existingConv.funnelType === 'PIX' || (existingConv.funnelId || '').includes('_PIX'));
            if (isPixConv) {
                await transferPixToApproved(convKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, orderBumps, paymentMethod, location, customerEmail);
            } else {
                for (const k of new Set([phoneKey, convKey])) {
                    const pt = pixTimeouts.get(k); if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(k); try { db.deletePixTimeout(k); } catch(e) {} }
                }
                await startFunnel(convKey, remoteJid, 'APROVADA', orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location, null, customerEmail);
            }
            // Repassa pro LinkRotator (sem await — fire-and-forget)
            relayToLinkRotator(isCard ? 'CARD_PAID' : 'SALE_APPROVED', relayPayload);
        } else if (isRefused) {
            // ⭐ 22/07: recusado agora cobre TODAS as formas de pagamento (antes só cartão).
            // Notifica sempre; o funil CARTAO_RECUSADO continua disparando só pra cartão sem funil ativo.
            const activeType = getActiveFunnelType(phoneKey);
            db.recordEvent('REFUSED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod, order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: normalizeFullPhone(customerPhone) });
            addLog('PAYMENT_REFUSED', `💳❌ ${isCard ? 'Cartão' : 'Pagamento'} recusado: ${customerName}${activeType ? ` (já em ${activeType} — funil não dispara)` : ''}`, { orderCode, phoneKey });
            {
                const notif = buildPaymentNotification(isCard ? 'card_refused' : 'payment_refused', customerName, netValue || amount, productName);
                await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
            }
            if (isCard && !activeType) {
                await startFunnel(phoneKey, remoteJid, 'CARTAO_RECUSADO', orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, 'CREDIT_CARD', location, null, customerEmail);
            }
        } else if (isAbandoned) {
            // ⭐ 22/07: registra o evento sempre (alimenta a lista de contatos por evento)
            db.recordEvent('ABANDONED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod, order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: normalizeFullPhone(customerPhone) });
            // ⭐ 15/05: Toggle global — se DESLIGADO, registra em events/log mas não dispara nada.
            // Funis em andamento NÃO são tocados (regra: só bloqueia NOVOS).
            if (!isAbandonoEnabled()) {
                addLog('ABANDONED_DISABLED', `🚫 Abandono DESLIGADO — ${customerName} ignorado (toggle global OFF)`, { orderCode, phoneKey });
                // SEM SSE/notif/push — silencioso
            } else {
                // ⭐ FIX 10/05: ABANDONED só dispara (notif + funil) se cliente NÃO está em outro funil ativo.
                // Regra do Iago: cliente em PIX/ABANDONO/etc só é interrompido por APROVADA.
                const activeType = getActiveFunnelType(phoneKey);
                if (activeType) {
                    // ⭐ FIX 06/26: era 100% silencioso — parecia que o webhook de abandono não chegava.
                    // Agora notifica (push + painel); só o FUNIL continua bloqueado (cliente já em outro funil).
                    addLog('ABANDONED_IGNORED', `🛒 Carrinho abandonado — funil bloqueado, cliente já em ${activeType} (${customerName})`, { orderCode, phoneKey });
                    sendSSE('cart_abandoned', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode, skipped: true });
                    {
                        const notif = buildPaymentNotification('cart_abandoned', customerName, amount, productName);
                        await sendPushNotification(notif.title, notif.body + ' · já está em outro funil', notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
                    }
                } else if (hasPaidRecently(phoneKey, 24)) {
                    // ⭐ FIX 07/26 HIERARQUIA: cliente já pagou nas últimas 24h — abandono (nível baixo) não dispara.
                    addLog('ABANDONED_PAID', `🛒 Carrinho abandonado ignorado — cliente já comprou nas últimas 24h (${customerName})`, { orderCode, phoneKey });
                } else {
                    addLog('ABANDONED', `🛒 Carrinho abandonado: ${customerName}`, { orderCode, phoneKey });
                    // ⭐ FIX 05/05: SSE pra tocar som no painel quando carrinho abandonado chega
                    sendSSE('cart_abandoned', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode });
                    // ⭐ FIX 10/05: push notification no celular com emoji 🛒 distinto (iPhone web push)
                    {
                        const notif = buildPaymentNotification('cart_abandoned', customerName, amount, productName);
                        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
                    }
                    await startFunnel(phoneKey, remoteJid, 'ABANDONO', orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location, null, customerEmail);
                }
            }
        } else if (isPix && event.includes('GENERATED')) {
            // ⭐ FIX 07/26 HIERARQUIA: PIX (nível 2) assume sobre ABANDONO/CARTÃO RECUSADO (nível 1),
            // mas NÃO dispara se já está em PIX/PIX_WAITING (2º Pix duplicado), em APROVADA, ou se já pagou.
            const activeType = getActiveFunnelType(phoneKey);
            const bloqueiaPix = hasPaidRecently(phoneKey, 24) || (activeType && funnelLevel(activeType) >= funnelLevel('PIX'));
            if (bloqueiaPix) {
                // Registra e notifica; só o FUNIL não dispara (duplicado ou já pagou).
                const motivo = hasPaidRecently(phoneKey, 24) ? 'já comprou' : `já em ${activeType}`;
                addLog('PIX_GENERATED_IGNORED', `⏳ PIX gerado mas funil não disparado — ${motivo} (${customerName})`, { orderCode, phoneKey });
                db.recordEvent('PIX_GENERATED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: 'PIX', order_code: orderCode, order_bumps: orderBumps, customer_name: customerName, customer_phone: normalizeFullPhone(customerPhone) });
                sendSSE('pix_generated', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode, skipped: true });
                {
                    const notif = buildPaymentNotification('pix_generated', customerName, netValue || amount, productName);
                    await sendPushNotification(notif.title, notif.body + ` · ${motivo}`, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
                }
            } else {
                // Sem funil ativo, ou em funil de nível MENOR (abandono) → createPixWaitingConversation
                // cancela o de abandono e assume (upgrade). Duplicata de mesmo tipo é tratada lá dentro.
                await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, 'PIX', location, pixExpiresAt, productsForSummary, customerEmail);
                // Repassa pro LinkRotator (sem await)
                relayToLinkRotator('PIX_GENERATED', relayPayload);
            }
        }
        res.json({ success: true, phoneKey });
        } finally { releaseWebhookLock(phoneKey); }
    } catch (error) { addLog('KIRVANO_ERR', error.message); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/webhook/perfectpay', async (req, res) => {
    try {
        if (PERFECTPAY_WEBHOOK_SECRET) {
            const ok = verifyWebhookHmac(req, PERFECTPAY_WEBHOOK_SECRET, ['x-perfectpay-signature', 'x-signature', 'x-webhook-signature']);
            if (!ok) {
                addLog('PERFECTPAY_HMAC_FAIL', '🚫 HMAC inválido — webhook rejeitado');
                return res.status(401).json({ success: false, message: 'invalid signature' });
            }
        }
        const data = req.body;
        const statusEnum = parseInt(data.sale_status_enum);
        const customerName = data.customer?.full_name || 'Cliente';
        const customerPhone = (data.customer?.phone_area_code || '') + (data.customer?.phone_number || '');
        const customerEmail = data.customer?.email || null;
        const customerDocument = data.customer?.identification_number || data.customer?.cpf || null;
        // Bruto = sale_amount (em centavos na PerfectPay)
        const saleAmount = (data.sale_amount || 0) / 100;
        // Líquido — PerfectPay manda em vários campos possíveis (em centavos)
        // Tenta producer_value > partner_amount > sale_amount_producer > fallback bruto
        const parseCentavos = (v) => {
            if (v === null || v === undefined || v === '') return null;
            const n = parseFloat(v);
            return isNaN(n) ? null : n / 100;
        };
        const netValue =
            parseCentavos(data.producer_value) ??
            parseCentavos(data.partner_amount) ??
            parseCentavos(data.sale_amount_producer) ??
            parseCentavos(data.commission?.value) ??
            saleAmount;
        const isCard = parseInt(data.payment_type_enum || 0) === 2;
        const paymentMethod = isCard ? 'CREDIT_CARD' : 'PIX';
        const pixCode = data.billet_url || data.pix_url || data.billet_number || null;
        // ⭐ FIX 10/05: PerfectPay envia expiração em campos variados; usar fallback 24h se ausente
        const pixExpiresAt = data.billet_due_date || data.pix_expiration || data.expires_at || null;
        // ⭐ FIX 10/05: lista de produtos pra resumo da página PIX (extractProductsForSummary aceita formato Kirvano-like)
        const ppProducts = Array.isArray(data.products) ? data.products : (data.plan?.name ? [{ name: data.plan.name, price: String(saleAmount), is_order_bump: false }] : []);
        const ppProductsForSummary = extractProductsForSummary(ppProducts);
        const productDb = data.plan?.code ? db.getProductByOfferId(data.plan.code) : null;
        const productId = productDb?.id || 'GRUPO_VIP';
        const productName = productDb?.name || data.plan?.name || 'GRUPO VIP';
        const orderCode = data.code || data.sale_id || `PP_${Date.now()}`;
        // UTMs — PerfectPay tem várias variações
        const utmSource = data.utm_source || data.marketing_utm_source || data.tracking?.utm_source || null;
        const utmCampaign = data.utm_campaign || data.marketing_utm_campaign || data.tracking?.utm_campaign || null;
        const utmMedium = data.utm_medium || data.marketing_utm_medium || data.tracking?.utm_medium || null;
        const utmContent = data.utm_content || data.marketing_utm_content || data.tracking?.utm_content || null;
        const utmTerm = data.utm_term || data.marketing_utm_term || data.tracking?.utm_term || null;

        // Determina o evento que vai pro logWebhook
        // sale_status_enum PerfectPay: 1=pendente · 2=aprovada · 5=recusada · 7=reembolsada · 9=chargeback
        const ppEvent = statusEnum === 2 ? 'SALE_APPROVED'
            : statusEnum === 1 ? 'PIX_GENERATED'
            : statusEnum === 5 ? 'SALE_REFUSED'
            : (statusEnum === 7 || statusEnum === 9) ? 'SALE_REFUNDED'
            : `STATUS_${statusEnum}`;

        // Auditoria — grava TODO webhook (mesmo recusado/abandono) pra ROI por campanha
        try {
            db.logWebhook({
                gateway: 'perfectpay',
                event: ppEvent,
                sale_id: orderCode,
                phone_key: null,
                customer_email: customerEmail,
                customer_document: customerDocument,
                utm_source: utmSource,
                utm_campaign: utmCampaign,
                utm_medium: utmMedium,
                utm_content: utmContent,
                utm_term: utmTerm,
                amount_gross: saleAmount,
                amount_net: netValue,
                payload_json: JSON.stringify(data)
            });
        } catch(e) { /* nunca quebra fluxo de venda */ }

        const phoneKey = normalizePhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) return res.json({ success: false });
        if (db.isBlacklisted(phoneKey)) return res.json({ success: true });

        // ⭐ FIX 04/05: Lock anti-race (mesmo motivo do Kirvano)
        const hasLock = await acquireWebhookLock(phoneKey, 30000);
        if (!hasLock) { addLog('PERFECTPAY_LOCKED', `🔒 Lock timeout para ${phoneKey}`); return res.status(503).json({ success: false }); }

        try {
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhoneUniversal(customerPhone, phoneKey);
        const location = db.getLocationFromPhone(customerPhone);

        addLog('PERFECTPAY', `${ppEvent} — ${customerName} · Bruto R$${saleAmount.toFixed(2)} · Líquido R$${netValue.toFixed(2)}`, { orderCode, phoneKey, productId });

        if (statusEnum === 2) {
            // Venda APROVADA — registra event no banco (entra no painel financeiro!)
            db.recordEvent(isCard ? 'CARD_PAID' : 'PIX_PAID', {
                phone_key: phoneKey,
                product_id: productId,
                product_name: productName,
                amount: saleAmount,
                net_value: netValue,
                payment_method: paymentMethod,
                order_code: orderCode,
                order_bumps: [],
                customer_name: customerName,
                customer_phone: normalizeFullPhone(customerPhone)
            });

            const existingConv = findConversationUniversal(customerPhone);
            const convKey = existingConv?.phoneKey || phoneKey;
            const isPixConv = existingConv && !existingConv.canceled && !existingConv.completed &&
                (existingConv.pixWaiting || existingConv.funnelType === 'PIX' || (existingConv.funnelId || '').includes('_PIX'));
            if (isPixConv) {
                await transferPixToApproved(convKey, remoteJid, orderCode, customerName, productId, productName, saleAmount, netValue, [], paymentMethod, location, customerEmail);
            } else {
                for (const k of new Set([phoneKey, convKey])) {
                    const pt = pixTimeouts.get(k); if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(k); try { db.deletePixTimeout(k); } catch(e) {} }
                }
                await startFunnel(convKey, remoteJid, 'APROVADA', orderCode, customerName, productId, productName, saleAmount, netValue, pixCode, [], paymentMethod, location, null, customerEmail);
            }
            res.json({ success: true });
        } else if (statusEnum === 1 && !isCard) {
            // ⭐ FIX 07/26 HIERARQUIA: PIX assume sobre abandono; bloqueia se já em PIX/APROVADA ou já pagou.
            const activeType = getActiveFunnelType(phoneKey);
            if (hasPaidRecently(phoneKey, 24) || (activeType && funnelLevel(activeType) >= funnelLevel('PIX'))) {
                const motivo = hasPaidRecently(phoneKey, 24) ? 'já comprou' : `já em ${activeType}`;
                addLog('PP_PIX_GENERATED_IGNORED', `⏳ PIX_GENERATED não disparado — ${motivo} (${customerName})`, { orderCode, phoneKey });
                return res.json({ success: true, ignored: 'hierarquia' });
            }
            // PIX gerado (aguardando pagamento) — registra event mas não entra no faturamento ainda
            db.recordEvent('PIX_GENERATED', {
                phone_key: phoneKey,
                product_id: productId,
                product_name: productName,
                amount: saleAmount,
                net_value: netValue,
                payment_method: 'PIX',
                order_code: orderCode,
                order_bumps: [],
                customer_name: customerName,
                customer_phone: normalizeFullPhone(customerPhone)
            });
            // A checagem de "já existe" é feita dentro de createPixWaitingConversation (respeita Modo Teste)
            // ⭐ FIX 10/05: passar pixExpiresAt + productsForSummary (faltavam — página PIX caía em 24h fixo e resumo vazio)
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productId, productName, saleAmount, netValue, pixCode, [], 'PIX', location, pixExpiresAt, ppProductsForSummary, customerEmail);
            res.json({ success: true });
        } else if (statusEnum === 7 || statusEnum === 9) {
            // ⭐ 22/07: reembolso/chargeback — cancela funil ativo, registra e notifica
            const existingConv = findConversationUniversal(customerPhone);
            const convKey = existingConv?.phoneKey || phoneKey;
            for (const k of new Set([phoneKey, convKey])) {
                const pt = pixTimeouts.get(k); if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(k); try { db.deletePixTimeout(k); } catch(e) {} }
            }
            if (existingConv && !existingConv.canceled && !existingConv.completed) {
                existingConv.canceled = true; existingConv.canceledAt = new Date(); existingConv.cancelReason = 'reembolso';
                conversations.set(convKey, existingConv);
                try { convToDb(convKey, existingConv); } catch(e) {}
                bumpEpoch(convKey);
            }
            try { db.cancelScheduledFunnelsByPhone(phoneKey, 'reembolso'); } catch(e) {}
            db.recordEvent('REFUNDED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount: saleAmount, net_value: netValue, payment_method: paymentMethod, order_code: orderCode, order_bumps: [], customer_name: customerName, customer_phone: normalizeFullPhone(customerPhone) });
            addLog('REFUNDED', `↩️ Reembolso (PerfectPay): ${customerName} · R$${(netValue || saleAmount || 0).toFixed(2)}`, { orderCode, phoneKey });
            {
                const notif = buildPaymentNotification('refund', customerName, netValue || saleAmount, productName);
                await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
            }
            res.json({ success: true });
        } else if (statusEnum === 5) {
            // ⭐ 22/07: pagamento recusado — notifica sempre; funil só pra cartão sem funil ativo
            const activeType = getActiveFunnelType(phoneKey);
            db.recordEvent('REFUSED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount: saleAmount, net_value: netValue, payment_method: paymentMethod, order_code: orderCode, order_bumps: [], customer_name: customerName, customer_phone: normalizeFullPhone(customerPhone) });
            addLog('PAYMENT_REFUSED', `💳❌ ${isCard ? 'Cartão' : 'Pagamento'} recusado (PerfectPay): ${customerName}`, { orderCode, phoneKey });
            {
                const notif = buildPaymentNotification(isCard ? 'card_refused' : 'payment_refused', customerName, netValue || saleAmount, productName);
                await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
            }
            if (isCard && !activeType) {
                await startFunnel(phoneKey, remoteJid, 'CARTAO_RECUSADO', orderCode, customerName, productId, productName, saleAmount, netValue, pixCode, [], 'CREDIT_CARD', location, null, customerEmail);
            }
            res.json({ success: true });
        } else res.json({ success: true });
        } finally { releaseWebhookLock(phoneKey); }
    } catch (error) { addLog('PERFECTPAY_ERR', error.message); res.status(500).json({ success: false }); }
});

// ============ PIX PAGE PÚBLICA ============
// URL do app de membros — usada nos botões da página PIX (expirado / pago)
const MEMBERS_APP_URL = process.env.MEMBERS_APP_URL || 'https://m.membrosvips.com';

// ⭐ Status público do PIX (token-gated): a página consulta a cada 5s pra detectar pagamento
// e virar tela de "pagamento confirmado" sozinha. Só devolve booleans — sem dados sensíveis.
app.get('/pix/:token/status', (req, res) => {
    try {
        const page = db.getPixPage(req.params.token);
        if (!page) return res.json({ paid: false, expired: true });
        // Pagamento do MESMO lead a partir de pouco antes da criação da página (margem de 2min pra clock skew)
        const paid = !!db.getDb().prepare(
            `SELECT 1 FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID')
             AND datetime(created_at) >= datetime(?, '-2 minutes') LIMIT 1`
        ).get(page.phone_key, page.created_at);
        res.json({ paid, expired: new Date(page.expires_at) < new Date() });
    } catch(e) { res.json({ paid: false, expired: false }); }
});

app.get('/pix/:token', (req, res) => {
    const page = db.getPixPage(req.params.token);
    if (!page) return res.status(404).send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Link expirado</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fff;color:#111;text-align:center;padding:24px}a.btn{display:inline-block;margin-top:18px;background:#111;color:#fff;text-decoration:none;font-weight:800;padding:16px 28px;border-radius:14px;font-size:15px}</style></head><body><div><h2 style="margin-bottom:8px">Esse link expirou</h2><p style="color:#6b7280;line-height:1.5">Mas calma — seu acesso ainda está disponível.<br>Toque abaixo pra entrar no app:</p><a class="btn" href="${MEMBERS_APP_URL}">IR PARA O APP</a></div></body></html>`);

    const expired = new Date(page.expires_at) < new Date();

    // ⭐ 22/07: página GENÉRICA — sem nome de produto/grupo (os produtos agora são vários).
    const firstName = formatName(page.customer_name || '');
    const title = firstName ? `${firstName}, falta pouco pra você receber seu acesso!` : 'Falta pouco pra você receber seu acesso!';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=${encodeURIComponent(page.pix_code)}`;

    // Só o total — sem listar nomes de produto
    let products = [];
    try { products = JSON.parse(page.products_json || '[]'); } catch(e) {}
    const fmtBRL = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    const totalValue = products.length ? products.reduce((s, p) => s + (Number(p.price) || 0), 0) : null;
    // amount_display vem do valor REAL da venda (fiscal.total_value do webhook) — fonte mais confiável que a soma dos itens
    const totalDisplay = page.amount_display || (totalValue != null ? fmtBRL(totalValue) : null);
    const summaryHtml = totalDisplay
        ? `<div class="summary">
              <div class="summary-total">
                <span>Total a pagar</span>
                <span class="total-value">${totalDisplay}</span>
              </div>
           </div>`
        : '';

    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Finalizar Pagamento</title>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;background:#fff;color:#111;min-height:100vh;padding-bottom:48px;}
  .body{padding:28px 20px 0;max-width:480px;margin:0 auto;}
  .headline{font-size:22px;font-weight:800;color:#111;line-height:1.2;letter-spacing:-0.3px;margin-bottom:6px;text-align:center;}
  .subline{font-size:14px;color:#6b7280;line-height:1.5;margin-bottom:22px;text-align:center;font-weight:500;}
  .subline strong{color:#111;}
  .cd-wrap{text-align:center;margin-bottom:22px;}
  .cd-label{font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:8px;}
  .cd-timer{font-size:32px;font-weight:800;color:#111;font-variant-numeric:tabular-nums;letter-spacing:3px;line-height:1;margin-bottom:10px;}
  .cd-timer.urgent{color:#dc2626;}
  .cd-bar-wrap{height:4px;background:#f3f4f6;border-radius:100px;overflow:hidden;}
  .cd-bar{height:100%;background:#111;border-radius:100px;width:100%;transition:width 1s linear;}
  .cd-bar.urgent{background:#dc2626;}
  .cd-after{display:none;font-size:13px;font-weight:700;color:#dc2626;margin-top:8px;line-height:1.4;}
  .divider{height:1px;background:#f3f4f6;margin:18px 0;}
  .summary{background:#fafafa;border:1px solid #f3f4f6;border-radius:12px;padding:16px 18px;margin-bottom:20px;}
  .summary-h{font-size:10px;font-weight:700;color:#9ca3af;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:12px;}
  .summary-item{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;padding:5px 0;}
  .summary-item.main{color:#111;font-weight:600;}
  .summary-item.bump{color:#6b7280;}
  .summary-item.bump::before{content:"+ ";color:#9ca3af;margin-right:2px;}
  .summary-item .price{color:#6b7280;font-variant-numeric:tabular-nums;font-weight:500;}
  .summary-item.main .price{color:#111;font-weight:600;}
  .summary-divider{height:1px;background:#e5e7eb;margin:10px 0;}
  .summary-total{display:flex;justify-content:space-between;align-items:center;font-weight:800;color:#111;font-size:15px;}
  .summary-total .total-value{font-size:19px;font-variant-numeric:tabular-nums;}
  .btn-wrap{position:sticky;bottom:14px;z-index:10;margin-bottom:10px;}
  .btn{width:100%;padding:20px;background:#16a34a;color:#fff;border:none;border-radius:14px;font-size:16px;font-weight:800;cursor:pointer;letter-spacing:0.3px;position:relative;overflow:hidden;transition:transform .1s;box-shadow:0 6px 28px rgba(22,163,74,0.35);animation:breathe 2s ease-in-out infinite;}
  @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.02)}}
  .btn::after{content:'';position:absolute;top:0;left:-100%;width:50%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent);animation:shine 2.5s infinite;}
  @keyframes shine{to{left:150%}}
  .btn:active{transform:scale(0.97);}
  .btn.ok{background:#15803d;animation:none;}
  .btn.ok::after{display:none;}
  .btn-hint{text-align:center;font-size:12px;color:#6b7280;font-weight:600;margin-bottom:24px;line-height:1.5;}
  .copied-help{display:none;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px 16px;font-size:13px;color:#166534;line-height:1.55;margin-bottom:22px;font-weight:600;}
  .steps-label{font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;}
  .steps{display:flex;flex-direction:column;gap:12px;margin-bottom:24px;}
  .step{display:flex;align-items:flex-start;gap:12px;}
  .step-n{width:22px;height:22px;border-radius:50%;background:#f0fdf4;border:1.5px solid #bbf7d0;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;color:#16a34a;}
  .step-t{font-size:13.5px;color:#4b5563;line-height:1.5;}
  .step-t strong{color:#111;font-weight:700;}
  .qr-area{text-align:center;margin-bottom:22px;}
  .qr-box{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:inline-block;margin-bottom:8px;}
  .qr-note{font-size:12px;color:#9ca3af;line-height:1.5;}
  .trust{display:flex;justify-content:center;gap:18px;margin-bottom:16px;flex-wrap:wrap;}
  .trust-item{font-size:11.5px;color:#6b7280;font-weight:600;display:flex;align-items:center;gap:5px;}
  .footer{text-align:center;font-size:11px;color:#d1d5db;padding-top:14px;border-top:1px solid #f3f4f6;}
  .state{display:none;text-align:center;padding:40px 10px 20px;}
  .state.show{display:block;}
  .state-icon{font-size:56px;margin-bottom:14px;line-height:1;}
  .state-h{font-size:23px;font-weight:800;margin-bottom:8px;letter-spacing:-0.3px;}
  .state-p{font-size:14px;color:#6b7280;line-height:1.6;margin-bottom:22px;}
  .state-p strong{color:#111;}
  .btn-app{display:block;width:100%;padding:20px;background:#111;color:#fff;text-decoration:none;border-radius:14px;font-size:16px;font-weight:800;letter-spacing:0.3px;box-shadow:0 4px 24px rgba(0,0,0,0.15);}
  .btn-app.green{background:#16a34a;box-shadow:0 6px 28px rgba(22,163,74,0.35);}
</style>
</head>
<body>
<div class="body">

  <!-- ===== ESTADO: PAGAMENTO CONFIRMADO (aparece sozinho quando o pagamento cai) ===== -->
  <div class="state" id="statePaid">
    <div class="state-icon">🎉</div>
    <div class="state-h">Pagamento confirmado!</div>
    <div class="state-p">Seu acesso <strong>já foi liberado</strong>.<br>Toque no botão abaixo pra entrar agora — e fica de olho no seu <strong>WhatsApp</strong>, que enviamos tudo por lá também. 💬</div>
    <a class="btn-app green" href="${MEMBERS_APP_URL}">ACESSAR MEU CONTEÚDO AGORA</a>
  </div>

  <!-- ===== ESTADO: PIX EXPIROU DE VERDADE ===== -->
  <div class="state ${expired ? 'show' : ''}" id="stateExpired">
    <div class="state-icon">⏰</div>
    <div class="state-h">Esse código Pix expirou</div>
    <div class="state-p">Mas calma: <strong>seu acesso ainda está disponível</strong>.<br>Toque no botão abaixo pra entrar no app e finalizar por lá:</div>
    <a class="btn-app" href="${MEMBERS_APP_URL}">IR PARA O APP</a>
  </div>

  <!-- ===== ESTADO NORMAL: PAGAR ===== -->
  <div id="statePay" style="${expired ? 'display:none' : ''}">
    <div class="headline">${title}</div>
    <div class="subline">Falta só <strong>1 passo</strong>: pague com Pix em menos de 1 minuto e receba o acesso <strong>na hora, no seu WhatsApp</strong>.</div>
    <div class="cd-wrap">
      <div class="cd-label">Acesso reservado pra você por</div>
      <div class="cd-timer" id="timer">03:00</div>
      <div class="cd-bar-wrap"><div class="cd-bar" id="cdBar"></div></div>
      <div class="cd-after" id="cdAfter">⚡ O tempo está acabando — pague agora pra não perder seu acesso!</div>
    </div>
    <div class="divider"></div>
    ${summaryHtml}
    <div class="btn-wrap"><button class="btn" id="btnPix" onclick="copyPix()">👇 COPIAR CÓDIGO PIX</button></div>
    <div class="btn-hint">Toque no botão verde — o código é copiado sozinho.<br>Depois é só colar no app do seu banco. Simples assim. 😉</div>
    <div class="copied-help" id="copiedHelp">✅ <strong>Código copiado!</strong> Agora abra o app do seu banco, toque em <strong>Pix → Pagar → Copia e Cola</strong>, segure o dedo no campo e escolha <strong>Colar</strong>. Confirme e pronto!</div>
    <div class="qr-area" id="qrArea" style="display:block">
      <div class="qr-note" style="margin-bottom:8px">Ou, se preferir, <strong style="color:#111">escaneie o QR Code</strong> com o app do banco:</div>
      <div class="qr-box"><img src="${qrUrl}" width="180" height="180" alt="QR Code PIX" style="display:block;border-radius:4px;"></div>
    </div>
    <div class="steps-label">Como pagar (passo a passo)</div>
    <div class="steps">
      <div class="step"><div class="step-n">1</div><div class="step-t">Toque no <strong>botão verde acima</strong> pra copiar o código Pix (ou escaneie o QR Code)</div></div>
      <div class="step"><div class="step-n">2</div><div class="step-t">Abra o <strong>app do seu banco</strong> e vá em <strong>Pix → Copia e Cola</strong></div></div>
      <div class="step"><div class="step-n">3</div><div class="step-t"><strong>Cole o código</strong> (segure o dedo no campo e toque em "Colar") e confirme</div></div>
      <div class="step"><div class="step-n">4</div><div class="step-t">Pronto! Seu <strong>acesso chega no WhatsApp em segundos</strong> ✅</div></div>
    </div>
    <div class="trust">
      <div class="trust-item">🔒 Pagamento seguro</div>
      <div class="trust-item">⚡ Aprovação na hora</div>
      <div class="trust-item">💬 Acesso no WhatsApp</div>
    </div>
    <div class="footer">Pagamento processado com segurança via Pix — Banco Central do Brasil</div>
  </div>

</div>
<script>
${!expired ? `
// ===== Cronômetro de urgência (NÃO bloqueia o pagamento ao zerar) =====
const TOTAL=3*60;let s=TOTAL;
const timerEl=document.getElementById('timer');
const barEl=document.getElementById('cdBar');
const tick=setInterval(()=>{
  s--;
  if(s<=0){clearInterval(tick);timerEl.textContent='00:00';timerEl.classList.add('urgent');barEl.style.width='0%';barEl.classList.add('urgent');
    document.getElementById('cdAfter').style.display='block';
    document.querySelector('.cd-label').textContent='Corre que ainda dá tempo';
    return;}
  timerEl.textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  barEl.style.width=(s/TOTAL*100)+'%';
  if(s<=60){timerEl.classList.add('urgent');barEl.classList.add('urgent');}
},1000);

function copyPix(){
  const code=${JSON.stringify(page.pix_code)};
  const btn=document.getElementById('btnPix');
  const done=()=>{
    btn.textContent='✅ COPIADO! ABRA O APP DO SEU BANCO';btn.classList.add('ok');
    document.getElementById('copiedHelp').style.display='block';
    setTimeout(()=>{btn.textContent='👇 COPIAR CÓDIGO PIX';btn.classList.remove('ok');},6000);
  };
  if(navigator.clipboard)navigator.clipboard.writeText(code).then(done).catch(()=>fb(code,done));else fb(code,done);
}
function fb(t,cb){const el=document.createElement('textarea');el.value=t;el.style.cssText='position:fixed;opacity:0';document.body.appendChild(el);el.select();try{document.execCommand('copy');cb();}catch(e){}document.body.removeChild(el);}

// ===== Detecção automática de pagamento: quando o Pix cai, a página vira tela de sucesso =====
let pollCount=0;
const poll=setInterval(async()=>{
  pollCount++;
  if(pollCount>360){clearInterval(poll);return;} // para depois de 30min
  try{
    const r=await fetch('/pix/${page.token}/status',{cache:'no-store'});
    const d=await r.json();
    if(d.paid){
      clearInterval(poll);clearInterval(tick);
      document.getElementById('statePay').style.display='none';
      document.getElementById('statePaid').classList.add('show');
      window.scrollTo(0,0);
    } else if(d.expired){
      clearInterval(poll);clearInterval(tick);
      document.getElementById('statePay').style.display='none';
      document.getElementById('stateExpired').classList.add('show');
      window.scrollTo(0,0);
    }
  }catch(e){}
},5000);
` : ''}
</script>
</body>
</html>`);
});

// ============ API ============
app.get('/api/dashboard', authMiddleware, (req, res) => {
    const today = db.getTodayStats(todayBR());
    const allConvs = [...conversations.values()];
    const active = allConvs.filter(c => !c.canceled && !c.completed && !c.pixWaiting);
    const convRate = today.pix_generated > 0 ? ((today.pix_paid + today.card_paid) / today.pix_generated * 100).toFixed(1) : '0';
    // ⭐ FIX 10/05: breakdown por tipo de funil (ABANDONO, PIX, APROVADA, ...)
    let funnelBreakdown = [];
    try { funnelBreakdown = db.getFunnelTypeBreakdown(todayBR()); } catch(e) { addLog('BREAKDOWN_ERR', e.message); }
    // ⭐ FIX 11/05: stats de recuperação (agendados, disparados, cancelados)
    let recoveryStats = null;
    try { recoveryStats = db.getRecoveryStats(todayBR()); } catch(e) {}
    // ⭐ FIX 11/05: stats de START_TRIGGER (anúncio → WhatsApp → palavra-chave)
    let startTriggerStats = null;
    try { startTriggerStats = db.getStartTriggerStats(todayBR()); } catch(e) {}
    res.json({ success: true, data: {
        active_conversations: active.filter(c => !c.waiting_for_response).length,
        waiting_responses: active.filter(c => c.waiting_for_response).length,
        pending_pix: pixTimeouts.size,
        completed_today: today.pix_paid + today.card_paid,
        pix_paid_today: today.pix_paid,
        card_paid_today: today.card_paid,
        revenue_today: today.revenue || 0,
        revenue_gross_today: today.revenue_gross || 0,
        revenue_net_today: today.revenue || 0,
        pix_generated_today: today.pix_generated || 0,
        conversion_rate: convRate,
        active_instances: isWabaConfigured() ? 1 : 0,
        total_instances: 1,
        waba_configured: isWabaConfigured(),
        test_mode: isTestModeActive(),
        funnel_breakdown: funnelBreakdown,
        recovery_stats: recoveryStats,
        start_trigger_stats: startTriggerStats
    }});
});

app.get('/api/conversations', authMiddleware, (req, res) => {
    const list = [...conversations.entries()].map(([phoneKey, conv]) => ({
        id: phoneKey, phone: (conv.remoteJid || '').replace('@s.whatsapp.net', ''), phoneKey,
        customerName: conv.customerName, customerEmail: conv.customerEmail || null, productId: conv.productId, productName: conv.productName,
        orderBumps: conv.orderBumps || [], funnelId: conv.funnelId, stepIndex: conv.stepIndex,
        amount: conv.amount, amountDisplay: conv.amountDisplay, netValue: conv.netValue,
        pixCode: conv.pixCode, paymentMethod: conv.paymentMethod,
        city: conv.city, state: conv.state, ddd: conv.ddd,
        waiting_for_response: conv.waiting_for_response, pixWaiting: conv.pixWaiting || false,
        createdAt: conv.createdAt, lastMessageAt: conv.lastSystemMessage, lastReplyAt: conv.lastReply,
        orderCode: conv.orderCode, stickyInstance: null,
        canceled: conv.canceled || false, completed: conv.completed || false,
        hasError: conv.hasError || false, paused: conv.paused || false,
        invalidNumber: conv.invalidNumber || false, reactivation: conv.reactivation || false,
        abFunnelVariant: conv.abFunnelVariant,
        pixTimeoutRemaining: pixTimeouts.has(phoneKey) ? Math.max(0, Math.round((getPixTimeoutMs() - (Date.now() - new Date(pixTimeouts.get(phoneKey).createdAt).getTime())) / 1000)) : null
    })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, data: list });
});

// ⭐ 20/07: ENVIO MANUAL — o Iago cadastra 1+ leads (número, nome, e-mail), escolhe o funil e o
// sistema dispara respeitando a distribuição normal (sticky se o lead já tem número fixado; senão
// próximo da fila). Envios espaçados (default 20s) pra não criar rajada na instância.
app.post('/api/manual-send', authMiddleware, (req, res) => {
    try {
        const { funnel_id, leads, spacing_seconds } = req.body || {};
        const funnel = db.getFunnelById(funnel_id);
        if (!funnel) return res.status(400).json({ success: false, error: 'Funil não encontrado' });
        if (!funnel.steps?.length) return res.status(400).json({ success: false, error: `O funil "${funnel.name || funnel_id}" está vazio — adicione mensagens nele primeiro` });
        if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ success: false, error: 'Nenhum lead informado' });
        if (leads.length > 100) return res.status(400).json({ success: false, error: 'Máximo de 100 leads por envio' });

        const spacingMs = Math.max(10, parseInt(spacing_seconds) || 20) * 1000;
        const productId = funnel.product_id || 'GRUPO_VIP';
        const productName = (db.getProducts().find(p => p.id === productId)?.name) || productId;

        const results = [];
        let scheduled = 0;
        for (const lead of leads) {
            const rawPhone = String(lead.phone || '').replace(/\D/g, '');
            const name = String(lead.name || '').trim() || 'Cliente';
            const email = String(lead.email || '').trim() || null;
            const phoneKey = normalizePhoneKey(rawPhone);
            if (!phoneKey || phoneKey.length !== 8) { results.push({ phone: lead.phone, ok: false, reason: 'Número inválido' }); continue; }
            if (db.isBlacklisted(phoneKey)) { results.push({ phone: lead.phone, ok: false, reason: 'Na blacklist' }); continue; }
            const existing = conversations.get(phoneKey);
            if (existing && !existing.canceled && !existing.completed) {
                results.push({ phone: lead.phone, ok: false, reason: `Já está em funil ativo (${existing.funnelType || existing.funnelId})` });
                continue;
            }

            const remoteJid = phoneToRemoteJid(rawPhone);
            const conv = {
                phoneKey, remoteJid, funnelId: funnel_id, stepIndex: 0,
                orderCode: 'MANUAL_' + Date.now() + '_' + scheduled,
                customerName: name, customerEmail: email,
                productId, productName,
                orderBumps: [], amount: 0, amountDisplay: '', netValue: 0,
                paymentMethod: 'PIX',
                ddd: null, city: null, state: null,
                waiting_for_response: false, createdAt: new Date(),
                canceled: false, completed: false, paused: false,
                funnelType: 'MANUAL'
            };
            conversations.set(phoneKey, conv);
            bumpEpoch(phoneKey);
            registerPhoneUniversal(rawPhone, phoneKey);
            try { convToDb(phoneKey, conv); } catch(e) {}

            const delay = scheduled * spacingMs;
            setTimeout(() => { try { sendStep(phoneKey); } catch(e) { addLog('MANUAL_SEND_ERR', `Erro no envio manual ${phoneKey}: ${e.message}`); } }, delay);
            scheduled++;
            results.push({ phone: lead.phone, ok: true, phoneKey, inSeconds: Math.round(delay / 1000) });
        }

        const totalMin = Math.ceil((scheduled * spacingMs) / 60000);
        if (scheduled > 0) addLog('MANUAL_SEND', `📤 Envio manual: ${scheduled} lead(s) → funil "${funnel.name || funnel_id}" (1 a cada ${spacingMs/1000}s, ~${totalMin}min no total)`);
        res.json({ success: true, scheduled, results });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/conversations/:phoneKey/pause', authMiddleware, (req, res) => {
    const conv = conversations.get(req.params.phoneKey);
    if (!conv) return res.status(404).json({ success: false });
    conv.paused = req.body.paused; conversations.set(req.params.phoneKey, conv);
    addLog('CONV_PAUSE', `${req.body.paused ? '⏸️' : '▶️'} ${req.params.phoneKey}`);
    res.json({ success: true });
});

// ⭐ FIX 04/05: Recuperação manual de leads presos com triagem inteligente.
// Mesma lógica do auto-recovery do boot: classifica pago/não pago, dispara funil correto, rate limit 30s.
// ⭐ FIX 10/05: Respeita waitForReply — leads aguardando resposta legítima NÃO são tocados.
// Suporta ?dryRun=1 (GET via query) para PREVIEW: retorna contagem SEM disparar nada — usado pelo warning do admin.
app.post('/api/recover-stuck', authMiddleware, (req, res) => {
    try {
        const RATE_MS = 30000;
        const cutoff = Date.now() - (24 * 60 * 60 * 1000);
        const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
        const candidates = [];
        let respectedWaitReply = 0;

        for (const [phoneKey, conv] of conversations.entries()) {
            if (conv.canceled || conv.completed || conv.paused || conv.invalidNumber || conv.pixWaiting) continue;
            const createdAt = conv.createdAt ? new Date(conv.createdAt).getTime() : 0;
            if (createdAt < cutoff) continue;
            const isStuck = !!conv.hasError; // canal oficial: só conversa com erro real de envio
            if (!isStuck) continue;

            // ⭐ FIX 10/05: Lead aguardando resposta legitimamente NÃO entra em recovery
            if (conv.waiting_for_response) {
                try {
                    const funnel = db.getFunnelById(conv.funnelId);
                    const currentStep = funnel?.steps?.[conv.stepIndex];
                    if (currentStep?.waitForReply) {
                        respectedWaitReply++;
                        if (!dryRun) {
                            // Limpa flags secundárias mas mantém waiting_for_response
                            if (conv.hasError || conv.awaitingPool) {
                                conv.hasError = false;
                                conv.awaitingPool = false;
                                conversations.set(phoneKey, conv);
                                try { convToDb(phoneKey, conv); } catch(e) {}
                            }
                            addLog('RECOVERY_RESPECT_WAIT', `🤫 ${conv.customerName || phoneKey} aguardando resposta no passo ${conv.stepIndex + 1}/${funnel?.steps?.length || '?'} — preservado (manual)`, { phoneKey });
                        }
                        continue;
                    }
                } catch(e) {}
            }

            candidates.push(phoneKey);
        }

        // Dry-run: retorna sem aplicar (pro warning do admin)
        if (dryRun) {
            // Pré-classifica pra mostrar no warning
            let previewAprovada = 0, previewPix = 0;
            for (const phoneKey of candidates) {
                try {
                    const paid = db.getDb().prepare(`SELECT type FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) > datetime('now','-2 days') LIMIT 1`).get(phoneKey);
                    if (paid) previewAprovada++; else previewPix++;
                } catch(e) { previewPix++; }
            }
            return res.json({
                success: true,
                dryRun: true,
                stuck: candidates.length,
                aprovada: previewAprovada,
                pix: previewPix,
                respectedWaitReply,
                durationMin: Math.round((candidates.length * RATE_MS) / 60000)
            });
        }

        let aprovada = 0, pix = 0;
        for (let i = 0; i < candidates.length; i++) {
            const phoneKey = candidates[i];
            const conv = conversations.get(phoneKey);
            if (!conv) continue;

            let alreadyPaid = false;
            try {
                const paid = db.getDb().prepare(`SELECT type FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) > datetime('now','-2 days') LIMIT 1`).get(phoneKey);
                alreadyPaid = !!paid;
            } catch(e) {}

            conv.waiting_for_response = false;
            conv.hasError = false;
            conv.awaitingPool = false;
            conv.stepIndex = 0;
            conv.lastSystemMessage = null;
            const funnelType = alreadyPaid ? 'APROVADA' : 'PIX';
            const selectedFunnel = selectABFunnel(conv.productId, funnelType);
            conv.funnelId = selectedFunnel;
            conv.abFunnelVariant = selectedFunnel;
            conv.funnelType = funnelType;
            conv.transferredFromPix = alreadyPaid;
            conversations.set(phoneKey, conv);
            try { convToDb(phoneKey, conv); } catch(e) {}

            if (alreadyPaid) aprovada++; else pix++;
            setTimeout(() => { try { sendStep(phoneKey); } catch(e) {} }, i * RATE_MS);
        }
        const totalMin = Math.round((candidates.length * RATE_MS) / 60000);
        addLog('MANUAL_RECOVERY', `🚑 Manual: ${aprovada} APROVADA + ${pix} PIX em ${totalMin}min · ${respectedWaitReply} preservado(s) aguardando resposta`);
        res.json({ success: true, recovered: candidates.length, aprovada, pix, respectedWaitReply, durationMin: totalMin });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Apaga conversa permanentemente (memória + banco)
app.delete('/api/conversations/:phoneKey', authMiddleware, (req, res) => {
    const phoneKey = req.params.phoneKey;
    try {
        // Remove da memória
        conversations.delete(phoneKey);
        const pt = pixTimeouts.get(phoneKey);
        if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
        // Remove do banco
        db.getDb().prepare('DELETE FROM conversations WHERE phone_key = ?').run(phoneKey);
        db.getDb().prepare('DELETE FROM pending_pix_timeouts WHERE phone_key = ?').run(phoneKey);
        db.getDb().prepare('DELETE FROM messages_log WHERE phone_key = ?').run(phoneKey);
        addLog('CONV_DELETED', `🗑️ Conversa apagada: ${phoneKey}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Limpa todos os dados de teste/histórico (mantém configurações, produtos, funis, gatilhos, instâncias identificadas)
app.post('/api/cleanup-test-data', authMiddleware, (req, res) => {
    try {
        const confirm = req.body?.confirm;
        if (confirm !== 'APAGAR TUDO') {
            return res.status(400).json({ success: false, error: 'Confirmação obrigatória' });
        }
        const summary = {};
        const tables = [
            'conversations', 'events', 'messages_log', 'word_frequency',
            'pending_pix_timeouts', 'funnel_receipts', 'instance_daily_stats',
            'phone_drops', 'phone_messages_daily',
            'notification_log', 'phone_variation_log'
        ];
        for (const t of tables) {
            try {
                const r = db.getDb().prepare(`DELETE FROM ${t}`).run();
                summary[t] = r.changes;
            } catch(e) { summary[t] = 'erro: ' + e.message; }
        }
        // Zera contadores de saúde dos números (mantém identificação)
        try {
            db.getDb().prepare(`UPDATE phone_numbers SET total_drops=0, total_bans=0, total_disconnects=0, total_messages_sent=0, last_drop_at=NULL, last_recovery_at=NULL`).run();
            summary['phone_numbers_reset'] = 'contadores zerados';
        } catch(e) {}
        // Limpa estado em memória
        conversations.clear();
        for (const pt of pixTimeouts.values()) clearTimeout(pt.timeout);
        pixTimeouts.clear();
        logs.length = 0;
        addLog('CLEANUP', '🧹 Dados de teste apagados — sistema pronto pra produção');
        res.json({ success: true, summary });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Zera eventos e stats de um dia específico (útil quando houve duplicação na migração)
app.post('/api/cleanup-day', authMiddleware, (req, res) => {
    try {
        const { date, confirm } = req.body || {};
        if (confirm !== 'APAGAR DIA') return res.status(400).json({ success: false, error: 'Confirmação obrigatória' });
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ success: false, error: 'Data inválida (use YYYY-MM-DD)' });

        const summary = {};
        const r1 = db.getDb().prepare(`DELETE FROM events WHERE date(created_at) = ?`).run(date);
        summary.events = r1.changes;
        const r2 = db.getDb().prepare(`DELETE FROM messages_log WHERE date(created_at) = ?`).run(date);
        summary.messages = r2.changes;
        const r3 = db.getDb().prepare(`DELETE FROM instance_daily_stats WHERE date = ?`).run(date);
        summary.instance_stats = r3.changes;
        const r4 = db.getDb().prepare(`DELETE FROM phone_messages_daily WHERE date = ?`).run(date);
        summary.phone_messages = r4.changes;

        addLog('CLEANUP_DAY', `🧹 Stats de ${date} zeradas: ${r1.changes} eventos, ${r2.changes} mensagens`);
        res.json({ success: true, summary });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/funnels', authMiddleware, (req, res) => res.json({ success: true, data: db.getFunnels() }));
app.post('/api/funnels', authMiddleware, (req, res) => {
    const funnel = req.body;
    if (!funnel.id || !funnel.name || !Array.isArray(funnel.steps)) return res.status(400).json({ success: false, error: 'id, name, steps obrigatórios' });
    funnel.steps.forEach((s, i) => { if (!s.id) s.id = 'step_' + Date.now() + '_' + i; });
    db.saveFunnel(funnel);
    addLog('FUNNEL_SAVED', `Funil salvo: ${funnel.id}`);
    res.json({ success: true, data: funnel });
});
app.post('/api/funnels/:funnelId/move-step', authMiddleware, (req, res) => {
    const funnel = db.getFunnelById(req.params.funnelId);
    if (!funnel) return res.status(404).json({ success: false });
    const from = parseInt(req.body.fromIndex), to = req.body.direction === 'up' ? from - 1 : from + 1;
    if (to < 0 || to >= funnel.steps.length) return res.status(400).json({ success: false });
    [funnel.steps[from], funnel.steps[to]] = [funnel.steps[to], funnel.steps[from]];
    db.saveFunnel(funnel); res.json({ success: true, data: funnel });
});
app.get('/api/funnels/export', authMiddleware, (req, res) => {
    const funnels = db.getFunnels();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="orion-funnels-${new Date().toISOString().split('T')[0]}.json"`);
    res.send(JSON.stringify({ version: '1.0', exportDate: new Date().toISOString(), funnels }, null, 2));
});
app.post('/api/funnels/import', authMiddleware, (req, res) => {
    const { funnels } = req.body;
    if (!Array.isArray(funnels)) return res.status(400).json({ success: false });
    let imported = 0;
    for (const f of funnels) { if (f.id && f.name && Array.isArray(f.steps)) { db.saveFunnel(f); imported++; } }
    addLog('FUNNELS_IMPORT', `Import: ${imported} funis`);
    res.json({ success: true, imported });
});

app.get('/api/products', authMiddleware, (req, res) => res.json({ success: true, data: db.getProducts() }));
app.post('/api/products', authMiddleware, (req, res) => {
    const p = req.body;
    if (!p.id || !p.name) return res.status(400).json({ success: false });
    db.saveProduct(p);
    addLog('PRODUCT_SAVED', `Produto: ${p.name}`); res.json({ success: true });
});
app.post('/api/products/:id/toggle', authMiddleware, (req, res) => { db.toggleProduct(req.params.id, req.body.active); res.json({ success: true }); });
app.post('/api/products/:id/ab-funnels', authMiddleware, (req, res) => { db.updateProductABFunnels(req.params.id, req.body.ab_funnel_ids || []); res.json({ success: true }); });
app.post('/api/products/:id/pix-page', authMiddleware, (req, res) => {
    try { db.updateProductPixPage(req.params.id, req.body); res.json({ success: true }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ EDIÇÃO DE PRODUTOS (v1.1) ============
// Atualizar nome do produto
app.put('/api/products/:id/name', authMiddleware, (req, res) => {
    try {
        const { name } = req.body || {};
        if (!name) return res.status(400).json({ success: false, error: 'name obrigatório' });
        db.updateProductName(req.params.id, name);
        addLog('PRODUCT_RENAMED', `Produto ${req.params.id} renomeado para: ${name}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Atualizar offers do produto (offer_ids vinculados)
app.put('/api/products/:id/offers', authMiddleware, (req, res) => {
    try {
        const offers = req.body.offers || [];
        db.updateProductOffers(req.params.id, offers);
        addLog('PRODUCT_OFFERS_UPDATED', `Produto ${req.params.id}: ${offers.length} offer(s) atualizado(s)`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Pegar offers do produto
app.get('/api/products/:id/offers', authMiddleware, (req, res) => {
    try { res.json({ success: true, data: db.getProductOffers(req.params.id) }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Deletar produto
app.delete('/api/products/:id', authMiddleware, (req, res) => {
    try {
        const result = db.deleteProduct(req.params.id);
        addLog('PRODUCT_DELETED', `Produto ${req.params.id} deletado (${result.deletedFunnels} funis vazios removidos)`);
        res.json({ success: true, ...result });
    } catch(e) { res.status(400).json({ success: false, error: e.message }); }
});

// ============ EDIÇÃO DE FUNIS (v1.1) ============
// Atualizar metadados do funil (nome, product_id, type)
app.put('/api/funnels/:id/meta', authMiddleware, (req, res) => {
    try {
        const { name, product_id, type } = req.body || {};
        db.updateFunnelMeta(req.params.id, { name, product_id, type });
        addLog('FUNNEL_META_UPDATED', `Funil ${req.params.id} atualizado`, { name, product_id, type });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Criar funil novo do zero
app.post('/api/funnels/create', authMiddleware, (req, res) => {
    try {
        const { id, product_id, type, name } = req.body || {};
        const newId = db.createFunnel({ id, product_id, type, name });
        addLog('FUNNEL_CREATED', `Funil criado: ${newId}`, { product_id, type, name });
        res.json({ success: true, id: newId });
    } catch(e) { res.status(400).json({ success: false, error: e.message }); }
});

// Deletar funil
app.delete('/api/funnels/:id', authMiddleware, (req, res) => {
    try {
        db.deleteFunnel(req.params.id);
        addLog('FUNNEL_DELETED', `Funil ${req.params.id} deletado`);
        res.json({ success: true });
    } catch(e) { res.status(400).json({ success: false, error: e.message }); }
});

app.get('/api/triggers', authMiddleware, (req, res) => res.json({ success: true, data: db.getTriggers() }));
app.post('/api/triggers', authMiddleware, (req, res) => { db.saveTrigger(req.body); res.json({ success: true }); });
app.delete('/api/triggers/:id', authMiddleware, (req, res) => { db.deleteTrigger(req.params.id); res.json({ success: true }); });

// ============ START TRIGGERS (gatilhos de início) ============
app.get('/api/start-triggers', authMiddleware, (req, res) => {
    try { res.json({ success: true, data: db.getStartTriggers() }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/start-triggers', authMiddleware, (req, res) => {
    try {
        const body = req.body || {};
        if (!body.name || !body.keywords || !body.target_funnel_id) {
            return res.status(400).json({ success: false, error: 'name, keywords e target_funnel_id são obrigatórios' });
        }
        const id = db.saveStartTrigger(body);
        res.json({ success: true, id });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/start-triggers/:id/toggle', authMiddleware, (req, res) => {
    try { db.toggleStartTrigger(req.params.id, !!req.body.active); res.json({ success: true }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
app.delete('/api/start-triggers/:id', authMiddleware, (req, res) => {
    try { db.deleteStartTrigger(req.params.id); res.json({ success: true }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ FIX 10/05: Endpoint de DIAGNÓSTICO — simula mensagem chegando sem disparar nada.
// Retorna passo-a-passo: o que o sistema enxergou e por que (não) bateu.
// Útil pra debugar quando Iago cadastra trigger e ele não funciona em produção.
app.post('/api/start-triggers/test', authMiddleware, (req, res) => {
    try {
        const text = String(req.body?.text || '');
        const instance = req.body?.instance ? String(req.body.instance) : null;
        if (!text.trim()) return res.status(400).json({ success: false, error: 'Texto obrigatório' });

        const result = checkStartTriggers(text, instance, true);
        const triggers = db.getActiveStartTriggers();
        const allTriggers = db.getStartTriggers();

        // Resolve dados do funil que dispararia
        let resolvedFunnel = null, resolvedProduct = null;
        if (result.trigger) {
            try {
                const f = db.getFunnelById(result.trigger.target_funnel_id);
                resolvedFunnel = f ? { id: f.id, name: f.name, steps: f.steps?.length || 0, enabled: !!f.enabled } : null;
                if (result.trigger.target_product_id) {
                    const p = db.getProducts().find(x => x.id === result.trigger.target_product_id);
                    resolvedProduct = p ? { id: p.id, name: p.name, active: !!p.active } : null;
                }
            } catch(e) {}
        }

        res.json({
            success: true,
            input: { text, instance, normalizedText: result.normalizedText },
            matched: !!result.trigger,
            trigger: result.trigger ? {
                id: result.trigger.id,
                name: result.trigger.name,
                keywords: result.trigger.keywords,
                match_type: result.trigger.match_type,
                target_funnel_id: result.trigger.target_funnel_id,
                target_product_id: result.trigger.target_product_id,
                instances_filter: result.trigger.instances,
                active: !!result.trigger.active
            } : null,
            resolved_funnel: resolvedFunnel,
            resolved_product: resolvedProduct,
            decision_trace: result.reasons,
            summary: {
                total_triggers: allTriggers.length,
                active_triggers: triggers.length,
                inactive_triggers: allTriggers.length - triggers.length
            },
            note: 'Diagnóstico read-only — NENHUMA conversa foi criada nem mensagem enviada.'
        });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Toggle ativo/inativo de funil
app.post('/api/funnels/:id/toggle', authMiddleware, (req, res) => {
    try { db.toggleFunnelEnabled(req.params.id, !!req.body.enabled); res.json({ success: true }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/blacklist', authMiddleware, (req, res) => res.json({ success: true, data: db.getBlacklist() }));
app.post('/api/blacklist/:phoneKey/remove', authMiddleware, (req, res) => { db.removeFromBlacklist(req.params.phoneKey); res.json({ success: true }); });

// ===== AÇÕES DE LEAD (chamadas pelo app mobile no drawer) =====
// GET /api/lead/:phoneKey → estado atual (em-funil, blacklist, agendamentos pendentes)
app.get('/api/lead/:phoneKey', authMiddleware, (req, res) => {
    try {
        const phoneKey = String(req.params.phoneKey || '').trim();
        if (!phoneKey) return res.status(400).json({ success: false, error: 'phoneKey vazio' });
        const conv = conversations.get(phoneKey);
        const blacklisted = db.isBlacklisted(phoneKey);
        const scheduled = db.getDb().prepare(
            `SELECT COUNT(*) as n FROM scheduled_funnels WHERE phone_key=? AND fired=0 AND cancelled=0`
        ).get(phoneKey)?.n || 0;
        res.json({
            success: true,
            data: {
                phoneKey,
                blacklisted,
                inFunnel: !!(conv && !conv.canceled && !conv.completed),
                paused: !!(conv && conv.paused),
                pixWaiting: !!(conv && conv.pixWaiting),
                customerName: conv?.customerName || null,
                productName: conv?.productName || null,
                stepIndex: conv?.stepIndex || 0,
                scheduledPending: scheduled
            }
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/lead/:phoneKey/block → blacklist + cancela agendamentos + cancela conv ativa
app.post('/api/lead/:phoneKey/block', authMiddleware, (req, res) => {
    try {
        const phoneKey = String(req.params.phoneKey || '').trim();
        if (!phoneKey) return res.status(400).json({ success: false, error: 'phoneKey vazio' });
        const reason = String(req.body?.reason || 'bloqueado_pelo_app').slice(0, 80);
        const conv = conversations.get(phoneKey);
        const phone = conv?.remoteJid?.replace('@s.whatsapp.net','') || phoneKey;
        db.addToBlacklist(phoneKey, phone, reason);
        const cancelledCount = db.cancelScheduledFunnelsByPhone(phoneKey, 'lead_bloqueado_app');
        // Cancela conversa ativa em memória
        if (conv && !conv.canceled) {
            conv.canceled = true; conv.canceledAt = new Date(); conv.cancelReason = 'lead_bloqueado_app';
            conversations.set(phoneKey, conv);
            try { convToDb(phoneKey, conv); } catch(e) {}
        }
        // Cancela PIX timeout pendente
        const pt = pixTimeouts.get(phoneKey);
        if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); try { db.deletePixTimeout(phoneKey); } catch(e){} }
        addLog('LEAD_BLOCKED_APP', `🚫 Lead bloqueado pelo app: ${phoneKey} (${reason})`, { cancelledScheduled: cancelledCount });
        res.json({ success: true, message: 'Lead bloqueado · ' + cancelledCount + ' agendamento(s) cancelado(s)', cancelledCount });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/lead/:phoneKey/cancel-next → cancela próximas mensagens agendadas sem bloquear
app.post('/api/lead/:phoneKey/cancel-next', authMiddleware, (req, res) => {
    try {
        const phoneKey = String(req.params.phoneKey || '').trim();
        if (!phoneKey) return res.status(400).json({ success: false, error: 'phoneKey vazio' });
        const cancelledCount = db.cancelScheduledFunnelsByPhone(phoneKey, 'cancelado_pelo_app');
        // Cancela conversa ativa em memória (não bloqueia o lead, só interrompe envio)
        const conv = conversations.get(phoneKey);
        if (conv && !conv.canceled && !conv.completed) {
            conv.canceled = true; conv.canceledAt = new Date(); conv.cancelReason = 'cancelado_pelo_app';
            conversations.set(phoneKey, conv);
            try { convToDb(phoneKey, conv); } catch(e) {}
        }
        // Cancela PIX timeout
        const pt = pixTimeouts.get(phoneKey);
        if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); try { db.deletePixTimeout(phoneKey); } catch(e){} }
        addLog('LEAD_CANCEL_NEXT_APP', `🗑️ Envio cancelado pelo app: ${phoneKey}`, { cancelledScheduled: cancelledCount });
        res.json({ success: true, message: 'Próximas mensagens canceladas · ' + cancelledCount + ' agendamento(s)', cancelledCount });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/lead/:phoneKey/pause → toggle paused (mantém conversa, só não envia)
app.post('/api/lead/:phoneKey/pause', authMiddleware, (req, res) => {
    try {
        const phoneKey = String(req.params.phoneKey || '').trim();
        if (!phoneKey) return res.status(400).json({ success: false, error: 'phoneKey vazio' });
        const conv = conversations.get(phoneKey);
        if (!conv) return res.json({ success: false, error: 'Lead não está em nenhum funil ativo' });
        conv.paused = !conv.paused;
        conv.pausedAt = conv.paused ? new Date() : null;
        conversations.set(phoneKey, conv);
        try { convToDb(phoneKey, conv); } catch(e) {}
        addLog(conv.paused ? 'LEAD_PAUSED_APP' : 'LEAD_RESUMED_APP', `${conv.paused?'⏸️ Pausado':'▶️ Retomado'} pelo app: ${phoneKey}`);
        res.json({ success: true, paused: conv.paused });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/analytics', authMiddleware, (req, res) => {
    const days = parseInt(req.query.days) || 7;
    const productId = req.query.product || null;
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const funnels = db.getFunnels();
    const abStats = funnels.filter(f => f.ab_leads > 0).map(f => ({ id: f.id, name: f.name, leads: f.ab_leads, conversions: f.ab_conversions, rate: f.ab_leads > 0 ? (f.ab_conversions / f.ab_leads * 100).toFixed(1) : '0' }));
    let eventStats;
    if (fromDate && toDate) {
        // Custom date range - get day by day stats
        eventStats = db.getDb().prepare(`SELECT date(created_at) as day,
            SUM(CASE WHEN type='PIX_GENERATED' THEN 1 ELSE 0 END) as pix_generated,
            SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN 1 ELSE 0 END) as paid,
            SUM(CASE WHEN type='PIX_PAID' THEN 1 ELSE 0 END) as pix_paid,
            SUM(CASE WHEN type='CARD_PAID' THEN 1 ELSE 0 END) as card_paid,
            SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as revenue
            FROM events WHERE date(created_at) BETWEEN ? AND ?
            GROUP BY date(created_at) ORDER BY day ASC`).all(fromDate, toDate);
    } else {
        eventStats = db.getEventStats(days);
        eventStats = eventStats.slice().reverse(); // chronological order
    }
    res.json({ success: true, data: { eventStats, topWords: db.getTopWords(productId, 30), dropoff: db.getFunnelDropoff(), instanceStats: db.getInstanceStats(days), abStats } });
});

// Efetividade dos funis: % de leads que pagaram DEPOIS de receber cada funil (PIX, abandono,
// cartão recusado, recuperação) + atividade de mensagens (enviadas, leads alcançados, taxa de resposta)
app.get('/api/analytics/funnel-effectiveness', authMiddleware, (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        res.json({ success: true, days, data: db.getFunnelEffectiveness(days) });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ WEB PUSH API ============
// Cria tabela de assinaturas se não existir
try {
    db.getDb().exec("CREATE TABLE IF NOT EXISTS push_subscriptions (sub_id TEXT PRIMARY KEY, subscription TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
    // Restaura assinaturas salvas
    const saved = db.getDb().prepare("SELECT sub_id, subscription FROM push_subscriptions").all();
    for (const row of saved) {
        try { pushSubscriptions.set(row.sub_id, JSON.parse(row.subscription)); } catch(e){}
    }
    if (saved.length > 0) console.log(`✅ ${saved.length} assinaturas push restauradas`);
} catch(e) { console.log('Push DB erro:', e.message); }

app.get('/api/push/vapid-key', (req, res) => {
    const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
    res.json({ publicKey: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ success: false });
    const id = require('crypto').createHash('md5').update(subscription.endpoint).digest('hex');
    pushSubscriptions.set(id, subscription);
    try {
        db.getDb().prepare("INSERT OR REPLACE INTO push_subscriptions (sub_id, subscription) VALUES (?, ?)").run(id, JSON.stringify(subscription));
    } catch(e) {}
    addLog('PUSH_SUB', `📱 Nova assinatura push registrada`);
    res.json({ success: true, id });
});

app.post('/api/push/unsubscribe', authMiddleware, (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ success: false });
    const id = require('crypto').createHash('md5').update(endpoint).digest('hex');
    pushSubscriptions.delete(id);
    try { db.getDb().prepare("DELETE FROM push_subscriptions WHERE sub_id=?").run(id); } catch(e){}
    res.json({ success: true });
});

// ===== SETTINGS API =====
app.get('/api/settings', authMiddleware, (req, res) => {
    const defaults = {
        // ⭐ FIX 11/05: editável no admin. Default mantido 7min (420000) pra retrocompat.
        //              Iago muda no painel pra 5min quando quiser (300000).
        PIX_TIMEOUT_MS: process.env.PIX_TIMEOUT_MS || '420000',
        REACTIVATION_DAYS: process.env.REACTIVATION_DAYS || '3',
        CLEANUP_DAYS: CLEANUP_DAYS.toString(),
        HIGH_TICKET_MIN: '50',
        TAX_RATE: '0.1215',
        MAX_FUNNELS_PER_LEAD_PER_DAY: '3',
        FUNNEL_COOLDOWN_DAYS: '7',
        TEST_MODE: '0',
        // ⭐ FIX 10/05: link de fallback editável pelo admin pra quando o link do cliente falhar
        PIX_FALLBACK_URL: 'https://m.membrosvips.com',
        // ⭐ FIX 10/05: URLs dos 3 sons (editáveis sem deploy)
        SOUND_PIX_URL:  'https://e-volutionn.com/wp-content/uploads/2026/04/ding-sound-effect_2_Sfdd45L.mp3',
        SOUND_PAY_URL:  'https://e-volutionn.com/wp-content/uploads/2026/04/u_byub5wd934-cashier-quotka-chingquot-sound-effect-129698.mp3',
        SOUND_CART_URL: 'https://e-volutionn.com/wp-content/uploads/2026/04/ding-sound-effect_2_Sfdd45L.mp3',
        // ⭐ FIX 11/05: sistema de RECUPERAÇÃO 24h pós-completar PIX/ABANDONO
        RECOVERY_FUNNEL_ENABLED: '0',           // opt-in (default OFF — segurança)
        RECOVERY_DELAY_HOURS: '24',
        RECOVERY_FUNNEL_ID_PIX: '',             // ID do funil que dispara após PIX completar (admin escolhe)
        RECOVERY_FUNNEL_ID_ABANDONO: ''         // ID do funil que dispara após ABANDONO completar
    };
    const saved = db.getAllSettings();
    res.json({ success: true, data: { ...defaults, ...saved } });
});
app.post('/api/settings', authMiddleware, (req, res) => {
    const urlFields = new Set(['PIX_FALLBACK_URL','SOUND_PIX_URL','SOUND_PAY_URL','SOUND_CART_URL']);
    const allowed = ['HIGH_TICKET_MIN','TAX_RATE','MAX_FUNNELS_PER_LEAD_PER_DAY','REACTIVATION_DAYS','FUNNEL_COOLDOWN_DAYS','TEST_MODE','PIX_FALLBACK_URL','SOUND_PIX_URL','SOUND_PAY_URL','SOUND_CART_URL','PIX_TIMEOUT_MS','RECOVERY_FUNNEL_ENABLED','RECOVERY_DELAY_HOURS','RECOVERY_FUNNEL_ID_PIX','RECOVERY_FUNNEL_ID_ABANDONO'];
    for (const [key, value] of Object.entries(req.body)) {
        if (!allowed.includes(key)) continue;
        // Sanitiza campos de URL — não deixa salvar vazio nem sem protocolo
        if (urlFields.has(key)) {
            const v = String(value || '').trim();
            if (v && /^https?:\/\//i.test(v)) db.setSetting(key, v);
            // se vier vazio, não salva nada — o fallback do GET assume o default
            continue;
        }
        // PIX_TIMEOUT_MS: sanitiza pra evitar valor inválido
        if (key === 'PIX_TIMEOUT_MS') {
            const n = parseInt(value);
            if (Number.isFinite(n) && n >= 60000 && n <= 60 * 60 * 1000) db.setSetting(key, String(n));
            continue;
        }
        // RECOVERY_DELAY_HOURS: 1-720h (1h a 30 dias)
        if (key === 'RECOVERY_DELAY_HOURS') {
            const n = parseInt(value);
            if (Number.isFinite(n) && n >= 1 && n <= 720) db.setSetting(key, String(n));
            continue;
        }
        db.setSetting(key, value);
    }
    res.json({ success: true });
});

// Endpoint dedicado pra ligar/desligar Modo Teste (mais conveniente que /api/settings)
app.post('/api/test-mode', authMiddleware, (req, res) => {
    const active = req.body?.active ? '1' : '0';
    db.setSetting('TEST_MODE', active);
    addLog(active === '1' ? 'TEST_MODE_ON' : 'TEST_MODE_OFF', active === '1' ? '🧪 MODO TESTE ATIVADO' : '✅ Modo Teste desativado');
    res.json({ success: true, active: active === '1' });
});
app.get('/api/test-mode', authMiddleware, (req, res) => {
    res.json({ success: true, active: db.getSetting('TEST_MODE') === '1' });
});

// ===== ABANDONO: TOGGLE GLOBAL + FILA PENDENTE (15/05) =====
// Status: toggle on/off + contadores (pending = aguardando instância, inFlight = em andamento dentro de 2h)
app.get('/api/abandono/status', authMiddleware, (req, res) => {
    try {
        const enabled = isAbandonoEnabled();
        const cutoff = Date.now() - (2 * 60 * 60 * 1000);
        let pending = 0, inFlight = 0;
        for (const [phoneKey, conv] of conversations.entries()) {
            if (conv.canceled || conv.completed) continue;
            if (conv.funnelType !== 'ABANDONO') continue;
            const createdAt = conv.createdAt ? new Date(conv.createdAt).getTime() : 0;
            if (createdAt < cutoff) continue;
            if (conv.awaitingPool) pending++;
            else inFlight++;
        }
        res.json({ success: true, enabled, pending, inFlight });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ ENVIO AUTOMÁTICO — kill switch universal + regras de valor ============
function autoSendState() {
    return {
        success: true,
        enabled: isAutoSendEnabled(),
        pix_enabled: db.getSetting('AUTO_SEND_PIX_ENABLED', '1') !== '0',
        aprovada_enabled: db.getSetting('AUTO_SEND_APROVADA_ENABLED', '1') !== '0',
        abandono_enabled: isAbandonoEnabled(),
        min_pix: parseFloat(db.getSetting('AUTO_SEND_MIN_PIX', '0')) || 0,
        min_aprovada: parseFloat(db.getSetting('AUTO_SEND_MIN_APROVADA', '0')) || 0,
        min_abandono: parseFloat(db.getSetting('AUTO_SEND_MIN_ABANDONO', '0')) || 0,
        first_only_pix: db.getSetting('AUTO_SEND_FIRST_ONLY_PIX', '0') === '1',
        first_only_aprovada: db.getSetting('AUTO_SEND_FIRST_ONLY_APROVADA', '0') === '1'
    };
}
app.get('/api/auto-send', authMiddleware, (req, res) => { res.json(autoSendState()); });
app.post('/api/auto-send', authMiddleware, (req, res) => {
    try {
        const b = req.body || {};
        if (b.enabled !== undefined) {
            db.setSetting('AUTO_SEND_ENABLED', b.enabled ? '1' : '0');
            addLog(b.enabled ? 'AUTO_SEND_ON' : 'AUTO_SEND_OFF',
                b.enabled ? '✅ Envio automático de mensagens LIGADO' : '🚫 Envio automático de mensagens DESLIGADO (funis em andamento serão interrompidos; Envio Manual continua funcionando)');
        }
        if (b.min_pix !== undefined) db.setSetting('AUTO_SEND_MIN_PIX', String(Math.max(0, parseFloat(b.min_pix) || 0)));
        if (b.min_aprovada !== undefined) db.setSetting('AUTO_SEND_MIN_APROVADA', String(Math.max(0, parseFloat(b.min_aprovada) || 0)));
        if (b.min_abandono !== undefined) db.setSetting('AUTO_SEND_MIN_ABANDONO', String(Math.max(0, parseFloat(b.min_abandono) || 0)));
        if (b.pix_enabled !== undefined) db.setSetting('AUTO_SEND_PIX_ENABLED', b.pix_enabled ? '1' : '0');
        if (b.aprovada_enabled !== undefined) db.setSetting('AUTO_SEND_APROVADA_ENABLED', b.aprovada_enabled ? '1' : '0');
        if (b.abandono_enabled !== undefined) db.setSetting('ABANDONO_ENABLED', b.abandono_enabled ? '1' : '0');
        if (b.first_only_pix !== undefined) db.setSetting('AUTO_SEND_FIRST_ONLY_PIX', b.first_only_pix ? '1' : '0');
        if (b.first_only_aprovada !== undefined) db.setSetting('AUTO_SEND_FIRST_ONLY_APROVADA', b.first_only_aprovada ? '1' : '0');
        res.json(autoSendState());
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Liga/desliga funil de abandono (NÃO toca funis em andamento — só bloqueia NOVOS)
app.post('/api/abandono/toggle', authMiddleware, (req, res) => {
    const active = req.body?.active ? '1' : '0';
    db.setSetting('ABANDONO_ENABLED', active);
    addLog(active === '1' ? 'ABANDONO_ON' : 'ABANDONO_OFF',
        active === '1' ? '✅ Funil de ABANDONO ATIVADO' : '🚫 Funil de ABANDONO DESATIVADO (funis em andamento continuam)');
    res.json({ success: true, active: active === '1' });
});

// Lista de abandonos aguardando instância (awaitingPool) das últimas 2h
app.get('/api/abandono/pending', authMiddleware, (req, res) => {
    try {
        const cutoff = Date.now() - (2 * 60 * 60 * 1000);
        const list = [];
        for (const [phoneKey, conv] of conversations.entries()) {
            if (conv.canceled || conv.completed) continue;
            if (conv.funnelType !== 'ABANDONO') continue;
            if (!conv.awaitingPool) continue;
            const createdAtMs = conv.createdAt ? new Date(conv.createdAt).getTime() : 0;
            if (createdAtMs < cutoff) continue;
            list.push({
                phoneKey,
                customerName: conv.customerName || phoneKey,
                amount: conv.amount || 0,
                netValue: conv.netValue || conv.amount || 0,
                productName: conv.productName || '',
                minutesAgo: Math.round((Date.now() - createdAtMs) / 60000),
                createdAt: conv.createdAt
            });
        }
        list.sort((a,b) => a.minutesAgo - b.minutesAgo);
        res.json({ success: true, total: list.length, pending: list });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Limpa fila: cancela TODOS os abandonos awaitingPool (sem disparar mensagem). Funis EM ANDAMENTO não tocam.
app.post('/api/abandono/clear', authMiddleware, (req, res) => {
    try {
        let cleared = 0;
        for (const [phoneKey, conv] of conversations.entries()) {
            if (conv.canceled || conv.completed) continue;
            if (conv.funnelType !== 'ABANDONO') continue;
            if (!conv.awaitingPool) continue;
            conv.canceled = true;
            conv.canceledAt = new Date();
            conv.cancelReason = 'manual_clear_app';
            conversations.set(phoneKey, conv);
            try { convToDb(phoneKey, conv); } catch(e) {}
            cleared++;
        }
        addLog('ABANDONO_CLEAR', `🗑️ ${cleared} abandono(s) pendente(s) limpo(s) pelo app`);
        res.json({ success: true, cleared });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Dispara TODOS os abandonos awaitingPool, espaçados a cada 30s.
app.post('/api/abandono/fire', authMiddleware, (req, res) => {
    try {
        const RATE_MS = 30000;
        const candidates = [];
        for (const [phoneKey, conv] of conversations.entries()) {
            if (conv.canceled || conv.completed) continue;
            if (conv.funnelType !== 'ABANDONO') continue;
            if (!conv.awaitingPool) continue;
            candidates.push(phoneKey);
        }
        let fired = 0;
        for (let i = 0; i < candidates.length; i++) {
            const phoneKey = candidates[i];
            const conv = conversations.get(phoneKey);
            if (!conv) continue;
            conv.awaitingPool = false;
            conv.hasError = false;
            conv.waiting_for_response = false;
            conversations.set(phoneKey, conv);
            try { convToDb(phoneKey, conv); } catch(e) {}
            fired++;
            setTimeout(() => { try { sendStep(phoneKey); } catch(e) {} }, i * RATE_MS);
        }
        const durationMin = Math.round((fired * RATE_MS) / 60000);
        addLog('ABANDONO_FIRE', `🚀 ${fired} abandono(s) pendente(s) disparado(s) pelo app · 1 a cada ${RATE_MS/1000}s (${durationMin}min total)`);
        res.json({ success: true, fired, durationMin });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ===== RESUMO DIÁRIO (histórico financeiro) =====
// GET /api/daily-summary?days=7  OR  ?from=YYYY-MM-DD&to=YYYY-MM-DD
// Mantém compat com ?days=N. Se vier from+to, usa o range (máx 92 dias).
// Usado pelo app mobile pra aba "Resumo" + tela após push noturno
app.get('/api/daily-summary', authMiddleware, (req, res) => {
    try {
        const { from, to } = req.query;
        const dates = [];
        if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
            const start = new Date(from + 'T00:00:00');
            const end = new Date(to + 'T00:00:00');
            if (end < start) return res.status(400).json({ success: false, error: 'to precisa ser ≥ from' });
            const diffDays = Math.floor((end - start) / 86400000) + 1;
            if (diffDays > 92) return res.status(400).json({ success: false, error: 'range máximo 92 dias' });
            // Ordem: mais recente primeiro (mesma convenção do modo ?days=N)
            for (let i = diffDays - 1; i >= 0; i--) {
                const d = new Date(start.getTime() + i * 86400000);
                dates.push(d.toISOString().split('T')[0]);
            }
        } else {
            const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 92);
            const today = new Date();
            for (let i = 0; i < days; i++) {
                const d = new Date(today);
                d.setDate(today.getDate() - i);
                dates.push(d.toISOString().split('T')[0]);
            }
        }

        const result = [];
        let aggGross = 0, aggNet = 0, aggPaid = 0, aggPixGen = 0;
        for (const dateStr of dates) {
            const finance = db.getFinanceDay(dateStr);
            const netRev = parseFloat(finance.net) || 0;
            const row = {
                date: dateStr,
                paid: finance.paid || 0,
                pix_paid: finance.pix_paid || 0,
                card_paid: finance.card_paid || 0,
                pix_generated: finance.pix_generated || 0,
                gross_revenue: parseFloat(finance.gross) || 0,
                net_revenue: netRev
            };
            aggGross += row.gross_revenue;
            aggNet += netRev;
            aggPaid += row.paid;
            aggPixGen += row.pix_generated;
            result.push(row);
        }
        res.json({
            success: true,
            data: result,
            totals: {
                days: dates.length,
                paid: aggPaid,
                pix_generated: aggPixGen,
                gross_revenue: aggGross,
                net_revenue: aggNet
            }
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== FUNNEL METRICS API =====
app.get('/api/funnel-metrics', authMiddleware, (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const d = db.getDb();
    const since = `datetime('now', '-${days} days')`;
    
    const total = d.prepare(`SELECT COUNT(*) as n FROM conversations WHERE datetime(created_at) > ${since}`).get().n || 0;
    const completed = d.prepare(`SELECT COUNT(*) as n FROM conversations WHERE completed=1 AND datetime(created_at) > ${since}`).get().n || 0;
    const invalidNumber = d.prepare(`SELECT COUNT(*) as n FROM conversations WHERE invalid_number=1 AND datetime(created_at) > ${since}`).get().n || 0;
    const pixReceived = d.prepare(`SELECT COUNT(*) as n FROM conversations WHERE funnel_id LIKE '%_PIX%' AND datetime(created_at) > ${since}`).get().n || 0;
    const pixPaid = d.prepare(`SELECT COUNT(*) as n FROM events WHERE type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) > ${since}`).get().n || 0;
    const stoppedMid = d.prepare(`SELECT COUNT(*) as n FROM conversations WHERE canceled=1 AND completed=0 AND invalid_number=0 AND step_index > 0 AND datetime(created_at) > ${since}`).get().n || 0;
    const neverReplied = d.prepare(`SELECT COUNT(*) as n FROM conversations WHERE canceled=1 AND completed=0 AND step_index <= 1 AND datetime(created_at) > ${since}`).get().n || 0;
    
    const pct = (n, t) => t > 0 ? ((n/t)*100).toFixed(1) : '0.0';
    
    res.json({ success: true, data: {
        total, completed, invalidNumber, pixReceived, pixPaid, stoppedMid, neverReplied,
        rates: {
            completed: pct(completed, total),
            pixPaid: pct(pixPaid, pixReceived),
            stoppedMid: pct(stoppedMid, total),
            invalidNumber: pct(invalidNumber, total),
            neverReplied: pct(neverReplied, total)
        }
    }});
});

app.post('/api/test/trigger', authMiddleware, (req, res) => {
    const { type, phoneKey, amount, customerName } = req.body;
    addLog('TEST', `🧪 ${type}`);
    if (type === 'pix_generated') { sendSSE('pix_generated', { phoneKey, customerName: customerName || 'Teste', productName: 'GRUPO VIP', amount: amount || 'R$ 29,90' }); }
    else if (type === 'payment_approved') { sendSSE('payment_approved', { phoneKey, customerName: customerName || 'Teste', productName: 'GRUPO VIP', amount: amount || 'R$ 29,90', paymentMethod: 'PIX' }); }
    res.json({ success: true });
});

// Teste de notificação push/whatsapp com valor configurável (pra preview de estrelas)
app.post('/api/test/notification', authMiddleware, async (req, res) => {
    const type = req.body?.type || 'pix_paid';
    const netValue = parseFloat(req.body?.netValue) || 30;
    const customerName = req.body?.customerName || 'Cliente Teste';
    const productName = req.body?.productName || 'Produto Teste';
    try {
        const notif = buildPaymentNotification(type, customerName, netValue, productName);
        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
        res.json({ success: true, preview: notif });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Versão em produção (público — usado pra confirmar deploy)
app.get('/api/version', (req, res) => {
    res.json({ version: APP_VERSION, started_at: APP_STARTED_AT });
});

// Preferências de notificação — toggles do app (cada tipo pode ser ligado/desligado)
const NOTIF_PREF_LIST = [
    { key: 'notif_pix_generated', label: 'PIX gerado' },
    { key: 'notif_payment', label: 'Pagamento aprovado' },
    { key: 'notif_cart_abandoned', label: 'Carrinho abandonado' },
    { key: 'notif_card_refused', label: 'Pagamento recusado' },
    { key: 'notif_refund', label: 'Reembolso' },
    { key: 'notif_morning_summary', label: 'Resumo da manhã (9h)' },
    { key: 'notif_daily_summary', label: 'Fechamento do dia (23:59)' },
    { key: 'notif_system', label: 'Avisos do sistema' }
];
app.get('/api/notification-prefs', authMiddleware, (req, res) => {
    const prefs = NOTIF_PREF_LIST.map(p => ({ ...p, enabled: db.getSetting(p.key, '1') !== '0' }));
    res.json({ success: true, prefs });
});
app.post('/api/notification-prefs', authMiddleware, (req, res) => {
    const updates = req.body || {};
    const validKeys = NOTIF_PREF_LIST.map(p => p.key);
    for (const [key, value] of Object.entries(updates)) {
        if (validKeys.includes(key)) db.setSetting(key, value ? '1' : '0');
    }
    const prefs = NOTIF_PREF_LIST.map(p => ({ ...p, enabled: db.getSetting(p.key, '1') !== '0' }));
    res.json({ success: true, prefs });
});

// ============ LISTA DE NÚMEROS (contato manual) ============
// Lista clientes por evento com filtros, sem duplicados (mantém o produto mais caro por telefone).
// PIX gerado só entra depois do timeout (7min) — antes disso o cliente ainda pode pagar sozinho.
app.get('/api/contacts', authMiddleware, (req, res) => {
    try {
        const event = String(req.query.event || 'PIX_GENERATED').toUpperCase();
        const minValue = parseFloat(req.query.min_value) || 0;
        const productName = req.query.product_name || '';
        const period = String(req.query.period || 'today');

        const dateConds = {
            today: "date(datetime(e.created_at,'-3 hours')) = date(datetime('now','-3 hours'))",
            yesterday: "date(datetime(e.created_at,'-3 hours')) = date(datetime('now','-3 hours','-1 day'))",
            '7d': "datetime(e.created_at) >= datetime('now','-7 days')",
            '30d': "datetime(e.created_at) >= datetime('now','-30 days')"
        };
        const dateCond = dateConds[period] || dateConds.today;

        const typeMap = {
            PIX_GENERATED: ['PIX_GENERATED'],
            PAID: ['PIX_PAID', 'CARD_PAID'],
            REFUSED: ['REFUSED'],
            REFUNDED: ['REFUNDED'],
            ABANDONED: ['ABANDONED'],
            ALL: ['PIX_GENERATED', 'PIX_PAID', 'CARD_PAID', 'REFUSED', 'REFUNDED', 'ABANDONED']
        };
        const types = typeMap[event] || typeMap.PIX_GENERATED;

        const pixDelaySec = Math.max(60, Math.round(getPixTimeoutMs() / 1000));
        let sql = `SELECT e.type, e.phone_key, e.product_id, e.product_name, e.amount, e.net_value,
                          e.payment_method, e.created_at, e.customer_name, e.customer_phone,
                          c.remote_jid AS conv_jid, c.customer_name AS conv_name, cl.contacted_at
                   FROM events e
                   LEFT JOIN conversations c ON c.phone_key = e.phone_key
                   LEFT JOIN contacted_log cl ON cl.phone_key = e.phone_key
                   WHERE e.type IN (${types.map(() => '?').join(',')})
                     AND ${dateCond}
                     AND e.phone_key IS NOT NULL
                     AND NOT (e.type = 'PIX_GENERATED' AND datetime(e.created_at) > datetime('now', '-${pixDelaySec} seconds'))`;
        const params = [...types];
        if (minValue > 0) { sql += ' AND COALESCE(e.amount, 0) >= ?'; params.push(minValue); }
        if (productName && productName !== 'ALL') { sql += ' AND e.product_name = ?'; params.push(productName); }
        sql += ' ORDER BY e.created_at DESC LIMIT 3000';
        const rows = db.getDb().prepare(sql).all(...params);

        // Quem já pagou nas últimas 48h sai das listas de "não-pagantes" (já converteu sozinho)
        const paidSet = new Set(
            db.getDb().prepare("SELECT DISTINCT phone_key FROM events WHERE type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) >= datetime('now','-2 days')")
                .all().map(r => r.phone_key)
        );

        // Dedup por telefone — mantém o evento de MAIOR valor; conta quantos eventos o cliente teve
        const byPhone = new Map();
        for (const r of rows) {
            if (['PIX_GENERATED', 'ABANDONED', 'REFUSED'].includes(r.type) && paidSet.has(r.phone_key)) continue;
            const cur = byPhone.get(r.phone_key);
            if (!cur) { r._count = 1; byPhone.set(r.phone_key, r); }
            else {
                cur._count++;
                if ((r.amount || 0) > (cur.amount || 0)) { r._count = cur._count; byPhone.set(r.phone_key, r); }
            }
        }

        let withoutPhone = 0;
        const contacts = [];
        for (const r of byPhone.values()) {
            const phone = String(r.customer_phone || (r.conv_jid || '').split('@')[0] || '').replace(/\D/g, '');
            if (!phone) { withoutPhone++; continue; }
            contacts.push({
                phone_key: r.phone_key,
                phone,
                name: r.customer_name || r.conv_name || 'Cliente',
                product_name: r.product_name || '—',
                amount: r.amount || 0,
                type: r.type,
                payment_method: r.payment_method,
                created_at: r.created_at,
                events_count: r._count,
                contacted_at: r.contacted_at || null
            });
        }
        contacts.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

        // ⭐ 22/07: link da página PIX do cliente (última gerada) — SÓ pra evento de PIX gerado
        // (venda aprovada não precisa: o cliente já pagou)
        const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
        const pixGenContacts = contacts.filter(c => c.type === 'PIX_GENERATED');
        if (appUrl && pixGenContacts.length) {
            const keys = pixGenContacts.map(c => c.phone_key);
            const pages = db.getDb().prepare(
                `SELECT phone_key, token, MAX(created_at) as mc FROM pix_pages WHERE phone_key IN (${keys.map(() => '?').join(',')}) GROUP BY phone_key`
            ).all(...keys);
            const pageMap = new Map(pages.map(p => [p.phone_key, p.token]));
            pixGenContacts.forEach(c => { const t = pageMap.get(c.phone_key); if (t) c.pix_url = `${appUrl}/pix/${t}`; });
        }

        // Produtos distintos do período (pro dropdown de filtro) — ignora filtro de produto atual
        const prodSql = `SELECT DISTINCT product_name FROM events e WHERE e.type IN (${types.map(() => '?').join(',')}) AND ${dateCond} AND product_name IS NOT NULL ORDER BY product_name`;
        const products = db.getDb().prepare(prodSql).all(...types).map(r => r.product_name);

        res.json({ success: true, data: contacts, products, without_phone: withoutPhone });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Marca/desmarca números como "já contatado" (chamado quando o operador copia)
app.post('/api/contacts/contacted', authMiddleware, (req, res) => {
    try {
        const keys = Array.isArray(req.body?.phone_keys)
            ? req.body.phone_keys.filter(k => typeof k === 'string' && k.length >= 4 && k.length <= 20)
            : [];
        if (!keys.length) return res.status(400).json({ success: false, error: 'phone_keys vazio' });
        const dbi = db.getDb();
        if (req.body?.clear) {
            const st = dbi.prepare('DELETE FROM contacted_log WHERE phone_key = ?');
            for (const k of keys) st.run(k);
        } else {
            const st = dbi.prepare("INSERT INTO contacted_log (phone_key, contacted_at) VALUES (?, datetime('now')) ON CONFLICT(phone_key) DO UPDATE SET contacted_at = datetime('now')");
            for (const k of keys) st.run(k);
        }
        res.json({ success: true, updated: keys.length, cleared: !!req.body?.clear });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Backup manual sob demanda
app.post('/api/backup/run', authMiddleware, (req, res) => {
    try { backupDatabase(); res.json({ success: true }); }
    catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/backup/list', authMiddleware, (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'data', 'backups');
        if (!fs.existsSync(backupDir)) return res.json({ success: true, backups: [] });
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('orion_') && f.endsWith('.db.gz'))
            .map(f => {
                const stat = fs.statSync(path.join(backupDir, f));
                return { name: f, size_mb: (stat.size / (1024*1024)).toFixed(2), created_at: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
        res.json({ success: true, backups: files });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Reconciliação histórica do net_value (corrige vendas antigas com % padrão)
app.post('/api/finance/reconcile-history', authMiddleware, (req, res) => {
    try {
        const pct = parseFloat(req.body?.commissionPercent);
        if (isNaN(pct) || pct < 0 || pct > 100) {
            return res.status(400).json({ success: false, error: 'commissionPercent deve ser número entre 0 e 100' });
        }
        const result = db.reconcileHistoricalNetValue(pct);
        addLog('RECONCILE', `🔧 Reconciliação: ${result.rowsUpdated} eventos atualizados com ${pct}%`);
        res.json({ success: true, ...result });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Configuração das estrelas
app.get('/api/settings/star-tiers', authMiddleware, (req, res) => {
    res.json({ success: true, ...getStarTiers() });
});
app.post('/api/settings/star-tiers', authMiddleware, (req, res) => {
    try {
        const { t1, t2, t3 } = req.body || {};
        if (t1 != null) db.setSetting('star_tier_1', String(parseFloat(t1) || 30));
        if (t2 != null) db.setSetting('star_tier_2', String(parseFloat(t2) || 60));
        if (t3 != null) db.setSetting('star_tier_3', String(parseFloat(t3) || 100));
        res.json({ success: true, ...getStarTiers() });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ FINANCE ENDPOINTS ============
app.get('/api/finance/day', authMiddleware, (req, res) => {
    const date = req.query.date || todayBR();
    res.json({ success: true, data: db.getFinanceDay(date) });
});
app.get('/api/finance/month', authMiddleware, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    const month = req.query.month || (new Date().getMonth() + 1);
    const days = db.getFinanceMonth(year, month);
    res.json({ success: true, year, month, days });
});
app.get('/api/finance/year', authMiddleware, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    res.json({ success: true, year, months: db.getFinanceYear(year) });
});

// ============ DEBUG — LISTA VENDAS DO DIA (cruzar com gateways) ============
// Read-only. Lista cada venda paga do dia pra cruzar com Kirvano/PerfectPay
// Uso: GET /api/debug/sales-day?date=2026-05-03
app.get('/api/debug/sales-day', authMiddleware, (req, res) => {
    try {
        const date = req.query.date || todayBR();
        // Eventos pagos do dia (PIX_PAID + CARD_PAID) — convertendo created_at UTC pra BR (-3h)
        const sales = db.getDb().prepare(`
            SELECT id, type, order_code, product_id, product_name, amount, net_value, payment_method,
                   datetime(created_at, '-3 hours') as created_br, created_at as created_utc, phone_key
            FROM events
            WHERE type IN ('PIX_PAID','CARD_PAID')
              AND date(datetime(created_at, '-3 hours')) = ?
            ORDER BY created_at ASC
        `).all(date);

        // Webhook logs do dia (mostra o que chegou de cada gateway, mesmo que tenha falhado em virar event)
        const webhooks = db.getDb().prepare(`
            SELECT id, gateway, event, sale_id, customer_email, amount_gross, amount_net,
                   utm_campaign, datetime(created_at, '-3 hours') as created_br
            FROM webhook_logs
            WHERE date(datetime(created_at, '-3 hours')) = ?
            ORDER BY created_at ASC
        `).all(date);

        const totals = sales.reduce((acc, s) => {
            const net = s.net_value || s.amount || 0;
            acc.gross += s.amount || 0;
            acc.net += net;
            acc.count += 1;
            if (s.type === 'PIX_PAID') acc.pix_count += 1;
            if (s.type === 'CARD_PAID') acc.card_count += 1;
            return acc;
        }, { gross: 0, net: 0, count: 0, pix_count: 0, card_count: 0 });

        res.json({
            success: true,
            date,
            totals,
            sales,
            webhook_logs: webhooks,
            webhook_count_by_gateway: webhooks.reduce((a, w) => {
                a[w.gateway || 'unknown'] = (a[w.gateway || 'unknown'] || 0) + 1;
                return a;
            }, {})
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ============ LINKROTATOR — REPLAY MANUAL ============
// Re-envia uma venda específica do banco webhook_logs pro LinkRotator
// (caso o relay original tenha falhado e o admin queira retentar)
app.post('/api/admin/replay-to-linkrotator/:saleId', authMiddleware, async (req, res) => {
    try {
        if (!LINKROTATOR_URL || !LINKROTATOR_TOKEN) {
            return res.status(400).json({ success: false, error: 'LinkRotator não configurado (LINKROTATOR_URL/TOKEN ausentes)' });
        }
        const saleId = req.params.saleId;
        const log = db.getDb().prepare('SELECT * FROM webhook_logs WHERE sale_id = ? ORDER BY id DESC LIMIT 1').get(saleId);
        if (!log) return res.status(404).json({ success: false, error: 'Webhook log não encontrado' });

        const data = JSON.parse(log.payload_json || '{}');
        const event = String(data.event || '').toUpperCase();
        const isApproved = event.includes('APPROVED') || event.includes('PAID');
        const isPix = event.includes('PIX_GENERATED') || event.includes('GENERATED');
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        const isCard = method.includes('CREDIT') || method.includes('CARD');
        const eventType = isPix ? 'PIX_GENERATED' : (isCard ? 'CARD_PAID' : 'SALE_APPROVED');

        const payload = {
            ref: data.utm?.utm_content || data.utm_content || data.customer?.utm_content || null,
            sale_id: log.sale_id,
            order_code: log.sale_id,
            customer_phone: log.customer_email ? data.customer?.phone_number : null,
            customer_name: data.customer?.name || null,
            customer_email: log.customer_email,
            amount_gross: log.amount_gross,
            amount_net: log.amount_net,
            product_name: data.products?.[0]?.name || data.product_name || null,
            payment_method: isCard ? 'CREDIT_CARD' : 'PIX',
            utm_source: log.utm_source,
            utm_campaign: log.utm_campaign
        };

        await relayToLinkRotator(eventType, payload);
        res.json({ success: true, replayed: true, event_type: eventType });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ BACKUP AUTOMÁTICO DO SQLITE ============
// Faz backup diário do banco em /app/data/backups, mantendo os últimos 14 backups.
// Roda às 3h da manhã (Brasília) + 1x no boot caso ainda não tenha rodado hoje.
const BACKUP_RETENTION = 14;
const BACKUP_HOUR_BR = 3; // 3h Brasília

function backupDatabase() {
    try {
        const dataDir = path.join(__dirname, 'data');
        const backupDir = path.join(dataDir, 'backups');
        const dbPath = path.join(dataDir, 'orion.db');

        if (!fs.existsSync(dbPath)) {
            addLog('BACKUP_SKIP', '⚠️ orion.db não encontrado — backup pulado');
            return;
        }
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
        const outFile = path.join(backupDir, `orion_${ts}.db.gz`);

        // Lê e comprime
        const raw = fs.readFileSync(dbPath);
        const gzipped = zlib.gzipSync(raw);
        fs.writeFileSync(outFile, gzipped);

        // Rotaciona — mantém últimos N
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('orion_') && f.endsWith('.db.gz'))
            .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
        const toDelete = files.slice(BACKUP_RETENTION);
        for (const f of toDelete) {
            try { fs.unlinkSync(path.join(backupDir, f.name)); } catch(e) {}
        }
        const sizeMB = (gzipped.length / (1024*1024)).toFixed(2);
        addLog('BACKUP_OK', `💾 Backup criado: ${path.basename(outFile)} (${sizeMB}MB) — ${Math.min(files.length + 1, BACKUP_RETENTION)} mantidos`);
    } catch(e) {
        addLog('BACKUP_ERR', `❌ Erro no backup: ${e.message}`);
    }
}

// Cleanup de webhook_logs antigos (mantém 90 dias) — roda junto com backup
function cleanupOldData() {
    try {
        const removed = db.cleanOldWebhookLogs(90);
        if (removed > 0) addLog('CLEANUP', `🧹 ${removed} webhook_logs antigos removidos`);
    } catch(e) { /* silent */ }
}

// Cleanup de pix_pages expiradas — roda a cada hora
function cleanupPixPages() {
    try {
        const removed = db.cleanExpiredPixPages();
        if (removed > 0) addLog('CLEANUP', `🧹 ${removed} pix_pages expiradas removidas`);
    } catch(e) { /* silent */ }
}

// Verifica a cada 15 min se já é hora de rodar o backup diário (3h BR)
let lastBackupDay = null;
function backupTick() {
    const nowBR = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const today = nowBR.toISOString().split('T')[0];
    const hour = nowBR.getUTCHours();
    if (hour >= BACKUP_HOUR_BR && lastBackupDay !== today) {
        lastBackupDay = today;
        backupDatabase();
        cleanupOldData();
    }
}
// Backup inicial: 60s após boot (caso seja primeira vez ou app ficou off durante 3h)
setTimeout(() => { backupDatabase(); cleanupOldData(); lastBackupDay = todayBR(); }, 60 * 1000);
// Verifica a cada 15 min
setInterval(backupTick, 15 * 60 * 1000);
// Cleanup pix_pages a cada 1h
setInterval(cleanupPixPages, 60 * 60 * 1000);
setTimeout(cleanupPixPages, 5 * 60 * 1000); // 1ª limpeza 5min após boot


// ============ RETROATIVO DA LISTA DE NÚMEROS (roda 1x) ============
// Antes de 22/07 os eventos não guardavam telefone/nome completos, e abandono/recusado/reembolso
// nem viravam evento. Este backfill reconstrói tudo a partir do webhook_logs (90 dias de payloads crus).
function backfillContactsData() {
    try {
        if (db.getSetting('CONTACTS_BACKFILL_V1', '0') === '1') return;
        const dbi = db.getDb();
        const logs = dbi.prepare('SELECT id, gateway, event, sale_id, amount_gross, amount_net, payload_json, created_at FROM webhook_logs WHERE payload_json IS NOT NULL ORDER BY id').all();
        let updated = 0, inserted = 0;
        const updStmt = dbi.prepare('UPDATE events SET customer_name = COALESCE(customer_name, ?), customer_phone = COALESCE(customer_phone, ?) WHERE order_code = ? AND (customer_phone IS NULL OR customer_name IS NULL)');
        const existsStmt = dbi.prepare('SELECT 1 FROM events WHERE order_code = ? AND type = ? LIMIT 1');
        const insStmt = dbi.prepare('INSERT INTO events (type, phone_key, product_id, product_name, amount, net_value, payment_method, order_code, order_bumps, customer_name, customer_phone, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const log of logs) {
            let data; try { data = JSON.parse(log.payload_json); } catch(e) { continue; }
            const isPP = log.gateway === 'perfectpay';
            const name = (isPP ? data.customer?.full_name : data.customer?.name) || null;
            const rawPhone = isPP ? ((data.customer?.phone_area_code || '') + (data.customer?.phone_number || '')) : (data.customer?.phone_number || '');
            const phone = normalizeFullPhone(rawPhone);
            const phoneKey = normalizePhoneKey(rawPhone);
            if (!phone || !phoneKey || phoneKey.length !== 8) continue;
            // 1) Completa nome/telefone dos eventos já existentes da mesma venda (PIX gerado antigo etc.)
            if (log.sale_id) { try { updated += updStmt.run(name, phone, log.sale_id).changes; } catch(e) {} }
            // 2) Recria eventos que não eram gravados na época (abandono/recusado/reembolso)
            const ev = String(log.event || '').toUpperCase();
            const st = String(data.status || '').toUpperCase();
            let missingType = null;
            if (ev.includes('ABANDON') || st === 'ABANDONED') missingType = 'ABANDONED';
            else if (ev.includes('REFUND') || ev.includes('CHARGEBACK') || st === 'REFUNDED') missingType = 'REFUNDED';
            else if (ev.includes('REFUSED') || ev.includes('DECLINED') || st === 'REFUSED' || st === 'DECLINED') missingType = 'REFUSED';
            if (missingType) {
                const saleId = log.sale_id || ('WL_' + log.id);
                if (!existsStmt.get(saleId, missingType)) {
                    const mainProduct = (Array.isArray(data.products) ? data.products : []).find(p => !p.is_order_bump) || null;
                    const productName = mainProduct?.name || data.plan?.name || 'GRUPO VIP';
                    insStmt.run(missingType, phoneKey, 'GRUPO_VIP', productName, log.amount_gross || 0, log.amount_net || 0, 'PIX', saleId, '[]', name, phone, log.created_at);
                    inserted++;
                }
            }
        }
        db.setSetting('CONTACTS_BACKFILL_V1', '1');
        addLog('CONTACTS_BACKFILL', `🧰 Retroativo da lista de Números: ${updated} eventos completados com nome/telefone · ${inserted} eventos antigos (abandono/recusado/reembolso) reconstruídos do webhook_logs`);
    } catch(e) { addLog('CONTACTS_BACKFILL_ERR', 'Backfill falhou: ' + e.message); }
}
setTimeout(backfillContactsData, 3000);

// ============ INICIALIZAÇÃO ============
app.listen(PORT, async () => {
    console.log('='.repeat(60));
    console.log(`🌌 ORION v${APP_VERSION} — Automação WhatsApp (Cloud API oficial da Meta)`);
    console.log('='.repeat(60));
    console.log(`✅ Porta: ${PORT}`);
    console.log(`${isWabaConfigured() ? '✅' : '⚠️ '} API oficial: ${isWabaConfigured() ? 'configurada (número ' + WABA_PHONE_NUMBER_ID + ')' : 'AGUARDANDO WABA_TOKEN / WABA_PHONE_NUMBER_ID no ambiente'}`);
    console.log(`${META_WEBHOOK_VERIFY_TOKEN ? '✅' : '⚠️ '} Webhook da Meta: ${META_WEBHOOK_VERIFY_TOKEN ? 'token de verificação definido' : 'defina META_WEBHOOK_VERIFY_TOKEN'}`);
    if (process.env.APP_URL) console.log(`✅ PIX pages ativas → ${process.env.APP_URL}/pix/:token`);
    if (PIX_DOMAIN) console.log(`✅ Isolamento de domínio PIX → ${PIX_DOMAIN}`);
    if (LINKROTATOR_URL && LINKROTATOR_TOKEN) console.log(`✅ Relay LinkRotator ativo → ${LINKROTATOR_URL}`);
    console.log('='.repeat(60));
    restorePendingConversations();
    restorePendingPixTimeouts();
    // Sincroniza números oficiais da WABA (qualidade/limite) no boot, se configurado
    if (WABA_TOKEN && WABA_ID) {
        waSyncNumbers().then(rows => console.log(`📱 ${rows.length} número(s) oficial(is) sincronizado(s) da Meta`)).catch(e => console.log('Sync números oficiais:', e.message));
    }
});
