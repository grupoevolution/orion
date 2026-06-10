const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const zlib = require('zlib');
const app = express();

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
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
// ⭐ FIX 04/05: parseInt("7m") = NaN → setTimeout(fn, NaN) dispara em 0ms (sem espera dos 7min).
// ⭐ FIX 11/05: editável no admin via settings.PIX_TIMEOUT_MS. Fallback mantido em 7min pra
//              retrocompat (NÃO mudar comportamento sem o Danilo trocar no admin manualmente).
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
    return 7 * 60 * 1000; // default mantido 7min (retrocompat) — Danilo muda no admin pra 5min
}
// Mantido pra retrocompat. Code novo usa getPixTimeoutMs() pra valor dinâmico.
let PIX_TIMEOUT = 7 * 60 * 1000;

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
const NOTIFICATION_INSTANCE = process.env.NOTIFICATION_INSTANCE; // instância pessoal — excluída do pool de envio
// HMAC secrets pra webhooks (opcionais; se vazios, segue sem verificação como hoje)
const KIRVANO_WEBHOOK_SECRET = process.env.KIRVANO_WEBHOOK_SECRET;
const PERFECTPAY_WEBHOOK_SECRET = process.env.PERFECTPAY_WEBHOOK_SECRET;
// ⭐ FIX 10/05: flag pra exigir HMAC. Quando ligar (=1), webhook SEM signature válida é rejeitado.
// Recomendação: ativar APÓS configurar secrets nos dashboards Kirvano/PerfectPay.
const WEBHOOK_HMAC_REQUIRED = process.env.WEBHOOK_HMAC_REQUIRED === '1';
// ⭐ FIX 10/05: token opcional pro webhook Evolution (Evolution não tem HMAC nativo, então usa shared token).
// Configure no Evolution: headers personalizados ou query string ?t=TOKEN
const EVOLUTION_WEBHOOK_TOKEN = process.env.EVOLUTION_WEBHOOK_TOKEN || '';
// LinkRotator integration (opcional — se vazio, não faz relay)
const LINKROTATOR_URL = process.env.LINKROTATOR_URL || '';
const LINKROTATOR_TOKEN = process.env.LINKROTATOR_TOKEN || '';
// Meta Ads integration (opcional — se vazio, aba Tráfego Pago fica desabilitada)
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
// Formato: "id1:Nome 1,id2:Nome 2" (sem prefixo act_; nome é livre pra label)
const META_AD_ACCOUNTS = process.env.META_AD_ACCOUNTS || '';
const META_API_VERSION = process.env.META_API_VERSION || 'v19.0';
const META_PAUSE_THRESHOLD = parseFloat(process.env.META_PAUSE_THRESHOLD || '30'); // R$ sem venda = sugerir pausar
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

// ============ RESTAURAR STICKY DO BANCO (sobrevive reinicializações) ============
function restoreStickyFromDB() {
    try {
        const rows = db.getDb().prepare("SELECT phone_key, sticky_instance FROM conversations WHERE sticky_instance IS NOT NULL AND canceled=0 AND completed=0").all();
        let restored = 0;
        for (const row of rows) {
            if (row.sticky_instance && row.phone_key) {
                stickyInstances.set(row.phone_key, row.sticky_instance);
                restored++;
            }
        }
        // Também restaurar para conversas concluídas recentes (últimos 7 dias) para reativação
        const recent = db.getDb().prepare("SELECT phone_key, sticky_instance FROM conversations WHERE sticky_instance IS NOT NULL AND datetime(created_at) > datetime('now','-7 days')").all();
        for (const row of recent) {
            if (row.sticky_instance && row.phone_key && !stickyInstances.has(row.phone_key)) {
                stickyInstances.set(row.phone_key, row.sticky_instance);
            }
        }
        if (restored > 0) console.log(`✅ Sticky restaurado: ${restored} clientes vinculados às suas instâncias`);
    } catch(e) { console.log('Sticky restore erro:', e.message); }
}

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
            if (row.sticky_instance) stickyInstances.set(row.phone_key, row.sticky_instance);
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

// ⭐ FIX 04/05: Recovery cirúrgico dos leads presos.
// Lógica: detecta quem ficou órfão por causa do bug, classifica (pago/não pago), dispara FUNIL CERTO,
// com rate limit pesado (30s entre envios) pra não sobrecarregar instância.
// Roda 1x no boot. Idade máxima 24h (lead mais velho não converte mais).
// SEGURANÇAS:
//  1. Cliente que JÁ pagou recebe APROVADA (não cobrança)
//  2. Cliente que NÃO pagou recebe PIX
//  3. Lead >24h é ignorado (frio)
//  4. 30s entre envios → instâncias não sobrecarregam
//  5. Distribui pelo load balancer normal (sticky novo é setado no envio)
async function recoverStuckConversations() {
    try {
        const RECOVERY_RATE_MS = 30000;        // 30s entre envios
        const RECOVERY_MAX_AGE_H = 24;          // só leads das últimas 24h
        const cutoff = Date.now() - (RECOVERY_MAX_AGE_H * 60 * 60 * 1000);
        const candidates = [];

        let respectedCount = 0; // ⭐ FIX 10/05: contador de leads preservados (waitForReply=true)
        for (const [phoneKey, conv] of conversations.entries()) {
            if (conv.canceled || conv.completed || conv.paused || conv.invalidNumber) continue;
            if (conv.pixWaiting) continue; // ainda dentro dos 7min, fluxo normal
            const createdAt = conv.createdAt ? new Date(conv.createdAt).getTime() : 0;
            if (createdAt < cutoff) continue; // lead frio, não tenta
            const hasSticky = !!stickyInstances.get(phoneKey);
            const stuck = (conv.waiting_for_response || conv.hasError || conv.awaitingPool) && !hasSticky;
            if (!stuck) continue;

            // ⭐ FIX 10/05: Lead AGUARDANDO RESPOSTA legitimamente NÃO entra em recovery.
            // Antes: recovery zerava o stepIndex e re-disparava funil do começo, duplicando mensagem.
            // Agora: se o passo atual era waitForReply=true, preserva o lead e limpa flags secundárias.
            if (conv.waiting_for_response) {
                try {
                    const funnel = db.getFunnelById(conv.funnelId);
                    const currentStep = funnel?.steps?.[conv.stepIndex];
                    if (currentStep?.waitForReply) {
                        // Limpa flags secundárias mas MANTÉM waiting_for_response=true
                        if (conv.hasError || conv.awaitingPool) {
                            conv.hasError = false;
                            conv.awaitingPool = false;
                            conversations.set(phoneKey, conv);
                            try { convToDb(phoneKey, conv); } catch(e) {}
                        }
                        addLog('RECOVERY_RESPECT_WAIT', `🤫 ${conv.customerName || phoneKey} aguardando resposta no passo ${conv.stepIndex + 1}/${funnel?.steps?.length || '?'} — preservado`, { phoneKey });
                        respectedCount++;
                        continue;
                    }
                } catch(e) {}
            }

            candidates.push(phoneKey);
        }

        if (candidates.length === 0) {
            if (respectedCount > 0) {
                console.log(`🚑 RECOVERY: 0 lead(s) presos · ${respectedCount} aguardando resposta (preservados)`);
                addLog('RECOVERY_NONE', `✅ Sem leads presos · ${respectedCount} aguardando resposta corretamente`);
            } else {
                console.log('🚑 RECOVERY: nenhum lead preso detectado');
            }
            return;
        }

        let aprovadaCount = 0, pixCount = 0;
        const totalMin = Math.round((candidates.length * RECOVERY_RATE_MS) / 60000);
        console.log(`🚑 RECOVERY: ${candidates.length} lead(s) preso(s) — espalhando em ~${totalMin}min`);
        addLog('RECOVERY_START', `🚑 ${candidates.length} lead(s) preso(s) — recuperação automática iniciada (1 a cada ${RECOVERY_RATE_MS/1000}s)`);

        for (let i = 0; i < candidates.length; i++) {
            const phoneKey = candidates[i];
            const conv = conversations.get(phoneKey);
            if (!conv) continue;

            // Triagem: cliente já pagou nas últimas 48h?
            let alreadyPaid = false;
            try {
                const paidEvent = db.getDb().prepare(
                    `SELECT type FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID') AND datetime(created_at) > datetime('now','-2 days') ORDER BY created_at DESC LIMIT 1`
                ).get(phoneKey);
                alreadyPaid = !!paidEvent;
            } catch(e) {}

            // Reseta flags travadas e re-aponta funil certo
            conv.waiting_for_response = false;
            conv.hasError = false;
            conv.awaitingPool = false;
            conv.stepIndex = 0;
            conv.lastSystemMessage = null; // força isFirstMessage=true → load balancer escolhe instância nova

            const funnelType = alreadyPaid ? 'APROVADA' : 'PIX';
            const selectedFunnel = selectABFunnel(conv.productId, funnelType);
            conv.funnelId = selectedFunnel;
            conv.abFunnelVariant = selectedFunnel;
            conv.funnelType = funnelType;
            conv.transferredFromPix = alreadyPaid; // pula intro se for APROVADA

            conversations.set(phoneKey, conv);
            try { convToDb(phoneKey, conv); } catch(e) {}

            if (alreadyPaid) aprovadaCount++; else pixCount++;
            addLog('RECOVERY_QUEUE', `${alreadyPaid ? '🟢' : '🟡'} [${i+1}/${candidates.length}] ${conv.customerName || phoneKey} → ${funnelType} (em ${Math.round(i*RECOVERY_RATE_MS/1000)}s)`, { phoneKey });

            setTimeout(() => { try { sendStep(phoneKey); } catch(e) {} }, i * RECOVERY_RATE_MS);
        }

        console.log(`🚑 RECOVERY agendado: ${aprovadaCount} APROVADA + ${pixCount} PIX em ${totalMin}min`);
        addLog('RECOVERY_DONE', `✅ ${aprovadaCount} APROVADA + ${pixCount} PIX agendados (espalhamento ${totalMin}min)`);
    } catch(e) { console.log('Recover stuck erro:', e.message); addLog('RECOVERY_ERR', `❌ ${e.message}`); }
}

// ============ ESTADO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let phoneVariations = new Map();
let lidMapping = new Map();
let phoneToLid = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let messageBlockTimers = new Map();
let lastSuccessfulInstanceIndex = -1;
let activeInstancesCache = [];
let sseClients = [];

// A/B: índice atual por produto
let abIndexMap = new Map();

// ⭐ FIX 05/05: índice round-robin pra distribuir entre instâncias ativas (em memória)
let _rrIndex = 0;

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

// ============ INSTÂNCIAS ============
let abandonoInstancesCache = [];
function refreshInstanceCache() {
    const all = db.getInstances();
    const NOTIF_NAMES = ['NOTIFICACAO','NOTIFICACOES','NOTIFICAÇAO','NOTIFICAÇÕES'];
    if (NOTIFICATION_INSTANCE) NOTIF_NAMES.push(NOTIFICATION_INSTANCE.toUpperCase());
    // Pool principal (PIX, APROVADA): exclui notificação e dedicadas a abandono
    activeInstancesCache = all.filter(i => !i.paused && i.connected && !i.is_notification && !i.is_abandono && !NOTIF_NAMES.includes(i.name.toUpperCase())).map(i => i.name);
    // ⭐ FIX 05/05: Pool de ABANDONO inteligente
    // - Se EXISTEM instâncias dedicadas (is_abandono=1) → usa só elas (chip queimável)
    // - Senão → todas ativas EXCETO as marcadas com block_abandono=1 (protege número principal)
    const dedicadas = all.filter(i => !i.paused && i.connected && i.is_abandono && !i.is_notification);
    if (dedicadas.length > 0) {
        abandonoInstancesCache = dedicadas.map(i => i.name);
    } else {
        abandonoInstancesCache = all.filter(i =>
            !i.paused && i.connected && !i.is_notification && !i.block_abandono && !NOTIF_NAMES.includes(i.name.toUpperCase())
        ).map(i => i.name);
    }
}

function getActiveInstances() { return activeInstancesCache; }
function getAbandonoInstances() { return abandonoInstancesCache; }

// Retorna o pool correto de instâncias baseado no tipo de funil do lead.
// ABANDONO, CARTAO_RECUSADO e RECUPERACAO usam pool isolado (chip queimável);
// demais usam o pool principal (números limpos).
function getPoolForFunnelType(funnelType) {
    if (funnelType === 'ABANDONO' || funnelType === 'CARTAO_RECUSADO' || funnelType === 'RECUPERACAO') {
        return abandonoInstancesCache;
    }
    return activeInstancesCache;
}
function getPoolForConversation(phoneKey) {
    const conv = conversations.get(phoneKey);
    return getPoolForFunnelType(conv?.funnelType);
}

const CONFIGURED_INSTANCES = (process.env.INSTANCES || 'F01').split(',').map(s => s.trim());
for (const inst of CONFIGURED_INSTANCES) db.ensureInstance(inst);
if (NOTIFICATION_INSTANCE) db.ensureInstance(NOTIFICATION_INSTANCE, true);
// Sempre marcar variantes de notificação como is_notification=true
// Garante que NUNCA entrem no pool de envio para clientes
db.ensureInstance('NOTIFICACAO', true);
db.ensureInstance('NOTIFICACOES', true);
// Forçar is_notification=1 para essas instâncias no banco (correção de dados existentes)
try {
    db.getDb().prepare("UPDATE instances SET is_notification=1 WHERE name IN ('NOTIFICACAO','NOTIFICACOES','NOTIFICAÇAO','NOTIFICAÇÕES')").run();
    // Limpar instâncias fantasma (name null ou vazio) que podem ter sido criadas por bugs anteriores
    db.getDb().prepare("DELETE FROM instances WHERE name IS NULL OR trim(name) = ''").run();
} catch(e) {}
refreshInstanceCache();

// ============ NOTIFICAÇÕES ============
// Preferências de notificação — controláveis pelo app (system_settings, default ligado).
// Mapeia o tipo do push para a chave de preferência correspondente.
const PUSH_PREF_KEYS = {
    pix_generated: 'notif_pix_generated',
    payment: 'notif_payment',
    card: 'notif_payment',
    cart_abandoned: 'notif_cart_abandoned',
    card_refused: 'notif_card_refused',
    daily_summary: 'notif_daily_summary',
    morning_summary: 'notif_morning_summary'
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
        const fbSpend = parseFloat(finance.facebook_spend) || 0;
        const taxRate = parseFloat(finance.tax_rate) || 0.1215;
        const netProfit = netRev - fbSpend - (fbSpend * taxRate);
        const roi = fbSpend > 0 ? (netRev / (fbSpend * (1 + taxRate))) : 0;

        if (period === 'morning') {
            const title = `Bom dia · ${totalSales} vendas · ${fmt(netRev)}`;
            const body = `PIX gerados ${today.pix_generated} · Conversão ${convRate}%` + (fbSpend > 0 ? ` · Gasto ${fmt(fbSpend)} · ROI ${roi.toFixed(2)}x` : '');
            await sendPushNotification(title, body, 'morning_summary');
        } else {
            const title = `Fechamento · ${totalSales} vendas · ${fmt(netRev)}`;
            const body = fbSpend > 0
                ? `Faturou ${fmt(netRev)} · Gastou ${fmt(fbSpend)} · Lucro ${fmt(netProfit)} · ROI ${roi.toFixed(2)}x`
                : `Faturou ${fmt(netRev)} · ${totalSales} vendas · Conversão ${convRate}% (sem gasto FB hoje)`;
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

function buildPaymentNotification(type, customerName, netValue) {
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
    } else {
        // fallback (compatibilidade com chamadas antigas)
        title = `Venda Aprovada · ${valor}`;
        pushType = 'payment';
    }

    return {
        title,
        body: nome,
        pushType,
        isFemale,
        highValue: isHighValue
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
            const fb = db.getSetting('PIX_FALLBACK_URL', 'https://e-volutionn.com/planosk/');
            linkPix = (fb && String(fb).trim()) || 'https://e-volutionn.com/planosk/';
            addLog('PIX_LINK_FALLBACK', `🟠 Link cliente indisponível — caindo no fallback (${linkPix})`, { phoneKey: conversation.phoneKey, orderCode: conversation.orderCode });
        } catch(e) {
            linkPix = 'https://e-volutionn.com/planosk/';
        }
    }
    r = r.replace(/\{PIX_LINK\}/g, () => linkPix);
    r = r.replace(/\{PIX_GERADO\}/g, () => safe(conversation.pixCode));
    r = r.replace(/\{PIX_CODE\}/g, () => safe(conversation.pixCode));
    r = r.replace(/\{NOME_CLIENTE\}/g, () => nomeFormatado);
    r = r.replace(/\{NOME\}/g, () => nomeFormatado);
    r = r.replace(/\{VALOR\}/g, () => safe(conversation.amountDisplay));
    r = r.replace(/\{PRODUTO\}/g, () => safe(conversation.productName));
    r = r.replace(/\{CIDADE\}/g, () => safe(conversation.city));
    r = r.replace(/\{ESTADO\}/g, () => safe(conversation.state));
    r = r.replace(/\{ORDER_BUMPS\}/g, () => Array.isArray(conversation.orderBumps) ? conversation.orderBumps.join(', ') : '');
    r = r.replace(/\{SAUDACAO\}/g, () => getSaudacao());
    return r;
}

// ============ A/B TEST ============
function selectABFunnel(productId, funnelType) {
    const product = db.getProducts().find(p => p.id === productId);
    if (!product) return productId + '_' + funnelType;

    let abFunnelIds = [];
    try { abFunnelIds = JSON.parse(product.ab_funnel_ids || '[]'); } catch {}

    // Filtra só funis do tipo correto
    const relevantFunnels = abFunnelIds.filter(id => {
        const f = db.getFunnelById(id);
        return f && (f.type === funnelType || id.includes(funnelType));
    });

    const defaultFunnel = productId + '_' + funnelType;
    if (relevantFunnels.length === 0) return defaultFunnel;

    // Adiciona o funil padrão ao pool se não estiver
    const pool = [defaultFunnel, ...relevantFunnels.filter(id => id !== defaultFunnel)];

    const key = productId + '_' + funnelType;
    const currentIdx = abIndexMap.get(key) || 0;
    const selectedFunnel = pool[currentIdx % pool.length];
    abIndexMap.set(key, currentIdx + 1);

    addLog('AB_SELECT', `🔄 A/B: ${selectedFunnel} (variante ${(currentIdx % pool.length) + 1}/${pool.length})`, { productId, funnelType });
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
            if (allowedInstances.length > 0 && instanceName && !allowedInstances.includes(instanceName)) {
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
async function startConversationFromTrigger(trigger, phoneKey, remoteJid, location, incomingInstance) {
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
            customerName: 'Cliente',
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

        // ⭐ FIX v1.2: Fixar instância de ORIGEM (instância que recebeu a mensagem do cliente)
        // Garante que a RESPOSTA sai do MESMO número que o cliente mandou
        // ÚNICO ponto de mudança — só afeta fluxo de Start Triggers
        if (incomingInstance) {
            const activeNow = getActiveInstances();
            if (activeNow.includes(incomingInstance)) {
                stickyInstances.set(phoneKey, incomingInstance);
                try {
                    db.getDb().prepare('UPDATE conversations SET sticky_instance=? WHERE phone_key=?').run(incomingInstance, phoneKey);
                } catch(e) {}
                addLog('STICKY_PRESET', `📌 Inst. fixada via webhook origem (trigger): ${incomingInstance}`, { phoneKey });
            } else {
                addLog('STICKY_PRESET_SKIP', `⚠️ Inst. origem "${incomingInstance}" não está ativa — usando seleção padrão`, { phoneKey });
            }
        }

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

function registerLidMapping(lidJid, phoneKey) {
    if (!lidJid || !phoneKey) return;
    lidMapping.set(lidJid, phoneKey); phoneToLid.set(phoneKey, lidJid);
    const lc = lidJid.split('@')[0].replace(/\D/g, '');
    if (lc) { lidMapping.set(lc, phoneKey); lidMapping.set(lc + '@lid', phoneKey); }
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
    if (String(phone).includes('@lid')) {
        const mk = lidMapping.get(phone) || lidMapping.get(String(phone).split('@')[0]);
        if (mk) { conv = conversations.get(mk); if (conv) return conv; }
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
        sticky_instance: stickyInstances.get(phoneKey),
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
    });
}

setInterval(() => { for (const [k, c] of conversations.entries()) convToDb(k, c); }, 15000);

setInterval(() => {
    const deleted = db.deleteOldConversations(CLEANUP_DAYS);
    if (deleted > 0) {
        for (const [k, c] of conversations.entries()) {
            if ((c.completed || c.canceled) && c.createdAt) {
                const age = (Date.now() - new Date(c.createdAt).getTime()) / 86400000;
                if (age > CLEANUP_DAYS) { conversations.delete(k); stickyInstances.delete(k); }
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
            stickyInstances.delete(k);
            removed++;
        }
    }
    if (removed > 0) addLog('MEM_CLEANUP', `🧹 ${removed} conversas finalizadas removidas da memória`);
}, 60 * 60 * 1000); // 1h

// ============ EVOLUTION API ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = `${EVOLUTION_BASE_URL}${endpoint}/${instanceName}`;
    try {
        const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY }, timeout: 15000 });
        const data = response.data || {};
        // ⭐ FIX 04/05 (atenuado): só bloqueia em erro EXPLÍCITO. hasMessageKey check removido pra evitar falso positivo
        // com formatos de resposta diferentes da Evolution. Se aparecer "EVO_FAKE_OK" no log, é erro real.
        if (endpoint.startsWith('/message/')) {
            const dataStatus = String(data.status || '').toUpperCase();
            const explicitError = dataStatus === 'ERROR' || dataStatus === 'FAILED' || dataStatus === 'FAIL' || (data.error && typeof data.error !== 'undefined' && data.error !== null && data.error !== false);
            if (explicitError) {
                addLog('EVO_FAKE_OK', `⚠️ Evolution 200 com erro [${instanceName}]: ${JSON.stringify(data).substring(0, 250)}`);
                return { ok: false, error: data.message || data.error || 'EVOLUTION_FAKE_OK', status: 200, data };
            }
        }
        return { ok: true, data };
    } catch (error) {
        const status = error.response?.status;
        const errBody = error.response?.data;
        const errStr = JSON.stringify(errBody || '').toLowerCase();
        // ⭐ FIX 04/05: Evolution mudou padrão — antes "not exist", agora "exists":false ou "number does not exist"
        const isInvalidNumber = status === 400 && (
            errStr.includes('not exist') ||
            errStr.includes('"exists":false') ||
            errStr.includes('exists\\":false') ||
            errStr.includes('not registered') ||
            errStr.includes('does not exist')
        );
        // Log detalhado (mantém só pra erros não-numéricos pra não poluir log)
        if (!isInvalidNumber) {
            addLog('EVO_HTTP_ERR', `❌ ${instanceName} ${endpoint}: HTTP ${status || error.code || 'NO_STATUS'} — ${JSON.stringify(errBody || '').substring(0, 200) || error.message?.substring(0, 200)}`);
        }
        return { ok: false, error: errBody || error.message, status, invalidNumber: isInvalidNumber };
    }
}

// Gera todas as variações possíveis de um número para envio
function generateSendVariations(phone) {
    const cleaned = String(phone).replace(/\D/g, '');
    const variations = new Set();
    
    // Base: número limpo
    variations.add(cleaned);
    
    // Com 55
    if (!cleaned.startsWith('55')) variations.add('55' + cleaned);
    // Sem 55
    if (cleaned.startsWith('55')) variations.add(cleaned.slice(2));
    
    // Extrai DDD e número
    let core = cleaned.startsWith('55') ? cleaned.slice(2) : cleaned;
    
    if (core.length >= 10) {
        const ddd = core.slice(0, 2);
        const num = core.slice(2);
        
        // Com 9 dígito
        if (num.length === 8) {
            variations.add(ddd + '9' + num);
            variations.add('55' + ddd + '9' + num);
        }
        // Sem 9 dígito
        if (num.length === 9 && num[0] === '9') {
            variations.add(ddd + num.slice(1));
            variations.add('55' + ddd + num.slice(1));
        }
        // Ambas com e sem 9
        variations.add('55' + ddd + num);
        variations.add(ddd + num);
    }
    
    // Ordena por probabilidade: com 55 e 9 dígito primeiro (formato mais comum no Brasil)
    return Array.from(variations).sort((a, b) => {
        const score = (n) => {
            let s = 0;
            if (n.startsWith('55')) s += 3;
            if (n.length === 13) s += 2; // 55 + DDD + 9 + 8 dígitos
            if (n.length === 11) s += 1; // DDD + 9 + 8 dígitos
            return s;
        };
        return score(b) - score(a);
    });
}

// Envia com fallback de variações de número
async function sendToEvolutionWithPhoneFallback(instanceName, endpoint, payload, originalPhone) {
    // Verifica se já temos uma variação que funcionou antes
    const knownVariation = db.getWorkingVariation(originalPhone);
    if (knownVariation) {
        const testPayload = { ...payload, number: knownVariation };
        const result = await sendToEvolution(instanceName, endpoint, testPayload);
        if (result.ok) return { ...result, usedVariation: knownVariation };
    }
    
    const variations = generateSendVariations(originalPhone);
    const failed = [];
    
    for (const variation of variations) {
        const testPayload = { ...payload, number: variation };
        const result = await sendToEvolution(instanceName, endpoint, testPayload);
        
        if (result.ok) {
            // Salva a variação que funcionou
            db.logPhoneVariation(originalPhone, variation, failed, true);
            addLog('PHONE_VAR_OK', `✅ Número funcionou: ${variation} (original: ${originalPhone})`);
            return { ...result, usedVariation: variation };
        }
        
        if (result.invalidNumber || result.status === 400) {
            failed.push(variation);
            continue; // Tenta próxima variação
        }
        
        // Erro de rede ou servidor - não é problema de número, retorna erro
        return result;
    }
    
    // Todas as variações falharam
    db.logPhoneVariation(originalPhone, null, failed, false);
    addLog('PHONE_VAR_FAIL', `❌ Todas as variações falharam para ${originalPhone} (${variations.length} tentadas)`);
    return { ok: false, invalidNumber: true, triedVariations: variations.length };
}

async function checkInstanceConnected(instanceName) {
    try {
        const r = await axios.get(`${EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`, { headers: { 'apikey': EVOLUTION_API_KEY }, timeout: 5000 });
        return r.data?.instance?.state === 'open';
    } catch { return false; }
}

// Busca o número de WhatsApp que está conectado nessa instância (via Evolution fetchInstances)
async function fetchInstanceOwnerNumber(instanceName) {
    try {
        const r = await axios.get(`${EVOLUTION_BASE_URL}/instance/fetchInstances`, {
            headers: { 'apikey': EVOLUTION_API_KEY },
            timeout: 8000,
            params: { instanceName }
        });
        const list = Array.isArray(r.data) ? r.data : [r.data];
        for (const item of list) {
            const inst = item?.instance || item;
            const name = inst?.instanceName || inst?.name;
            if (name === instanceName) {
                // Diferentes formatos da Evolution. Tenta múltiplos campos:
                const ownerJid = inst?.owner || inst?.ownerJid || inst?.profilePicUrl && inst?.profileName && inst?.number;
                const raw = inst?.owner || inst?.ownerJid || inst?.number || null;
                if (!raw) return null;
                // extrai apenas dígitos (remove @s.whatsapp.net, :device, etc)
                const digits = String(raw).replace(/@.*$/, '').replace(/:.*$/, '').replace(/\D/g, '');
                return digits || null;
            }
        }
    } catch(e) { /* silencia */ }
    return null;
}

// ⭐ FIX 05/05: Evolution v2 nova exige delay no nível raiz, não dentro de options. Manda nos 2 lugares pra compatibilidade.
async function sendPresence(remoteJid, instanceName, seconds) {
    if (!instanceName) return;
    const delay = Math.min(seconds * 1000, 25000);
    const number = remoteJid.replace('@s.whatsapp.net', '');
    try { await sendToEvolution(instanceName, '/chat/sendPresence', { number, presence: 'composing', delay, options: { presence: 'composing', delay } }); } catch {}
}

async function blockContact(remoteJid, instanceName) {
    try { await sendToEvolution(instanceName, '/chat/updateBlockStatus', { number: remoteJid.replace('@s.whatsapp.net', ''), status: 'block' }); } catch {}
}

async function sendText(remoteJid, text, instanceName) {
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    return sendToEvolutionWithPhoneFallback(instanceName, '/message/sendText', { text }, phone);
}
async function sendImage(remoteJid, url, caption, instanceName) {
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    return sendToEvolutionWithPhoneFallback(instanceName, '/message/sendMedia', { mediatype: 'image', media: url, caption: caption || '' }, phone);
}
async function sendVideo(remoteJid, url, caption, instanceName) {
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    return sendToEvolutionWithPhoneFallback(instanceName, '/message/sendMedia', { mediatype: 'video', media: url, caption: caption || '' }, phone);
}
async function sendSticker(remoteJid, url, instanceName) {
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    return sendToEvolutionWithPhoneFallback(instanceName, '/message/sendSticker', { sticker: url }, phone);
}

async function sendAudio(remoteJid, audioUrl, instanceName) {
    // ⭐ FIX 04/05: causa raiz das perdas! Evolution rejeita base64 com prefixo "data:audio/mpeg;base64,"
    // Agora usa sendToEvolutionWithPhoneFallback (testa variações de número como sendText/sendImage fazem).
    // Estratégia: 1) URL direta + variações  2) base64 puro + variações  3) fallback sendMedia
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    const r1 = await sendToEvolutionWithPhoneFallback(instanceName, '/message/sendWhatsAppAudio', { audio: audioUrl, delay: 1200, encoding: true }, phone);
    if (r1.ok) return r1;
    if (r1.invalidNumber) return r1; // número realmente não existe — não desperdiça download
    try {
        const audioResponse = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const base64 = Buffer.from(audioResponse.data).toString('base64');
        const r2 = await sendToEvolutionWithPhoneFallback(instanceName, '/message/sendWhatsAppAudio', { audio: base64, delay: 1200, encoding: true }, phone);
        if (r2.ok) return r2;
        return sendToEvolutionWithPhoneFallback(instanceName, '/message/sendMedia', { mediatype: 'audio', media: base64, mimetype: 'audio/mpeg' }, phone);
    } catch(e) {
        return r1;
    }
}

async function sendViewOnce(remoteJid, mediaUrl, mediaType, instanceName) {
    // ⭐ FIX 04/05: idem — URL direta + fallback de variações + base64 se URL falhar
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    const r1 = await sendToEvolutionWithPhoneFallback(instanceName, '/message/sendMedia', { mediatype: mediaType, media: mediaUrl, viewOnce: true }, phone);
    if (r1.ok) return r1;
    if (r1.invalidNumber) return r1;
    try {
        const resp = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const mimetype = mediaType === 'image' ? 'image/jpeg' : 'video/mp4';
        const b64 = Buffer.from(resp.data).toString('base64');
        return sendToEvolutionWithPhoneFallback(instanceName, '/message/sendMedia', { mediatype: mediaType, media: b64, mimetype, viewOnce: true }, phone);
    } catch(e) {
        return r1;
    }
}

// ============ SELEÇÃO DE INSTÂNCIA (distribuição inteligente) ============
// ============ v1.3 BALANCEAMENTO INTELIGENTE ============
// Conta quantos clientes ativos cada instância tem como sticky
function countActiveStickysByInstance() {
    const counts = {};
    for (const [phoneKey, instName] of stickyInstances.entries()) {
        if (!instName) continue;
        const conv = conversations.get(phoneKey);
        // Só conta conversas vivas (não canceladas, não completas há muito)
        if (conv && !conv.canceled) {
            counts[instName] = (counts[instName] || 0) + 1;
        }
    }
    return counts;
}

// v1.3: SCORE de carga por instância (menor = mais ociosa = melhor escolha)
// Considera: msgs hoje (peso 1.0) + msgs ontem (peso 0.5) + stickys ativos (peso 0.3)
function computeInstanceScores(active) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const stats = db.getInstanceStats(2); // hoje + ontem
    const todayStats = {}, yesterdayStats = {};
    for (const inst of active) { todayStats[inst] = 0; yesterdayStats[inst] = 0; }
    for (const s of stats) {
        if (s.date === today && todayStats[s.instance] !== undefined) todayStats[s.instance] = s.messages_sent;
        if (s.date === yesterday && yesterdayStats[s.instance] !== undefined) yesterdayStats[s.instance] = s.messages_sent;
    }

    const stickyCount = countActiveStickysByInstance();

    return active.map(inst => ({
        instance: inst,
        msgs_today: todayStats[inst] || 0,
        msgs_yesterday: yesterdayStats[inst] || 0,
        active_stickys: stickyCount[inst] || 0,
        score: (todayStats[inst] || 0) * 1.0
             + (yesterdayStats[inst] || 0) * 0.5
             + (stickyCount[inst] || 0) * 0.3
    }));
}

function selectNextInstance(isFirstMessage, phoneKey) {
    const active = getPoolForConversation(phoneKey);
    if (active.length === 0) return null;
    if (active.length === 1) return active[0];

    let stickyInstance = stickyInstances.get(phoneKey);
    // Se não está na memória, tenta restaurar do banco
    if (!stickyInstance) {
        try {
            const row = db.getDb().prepare('SELECT sticky_instance FROM conversations WHERE phone_key=? AND sticky_instance IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(phoneKey);
            if (row?.sticky_instance) {
                stickyInstance = row.sticky_instance;
                stickyInstances.set(phoneKey, stickyInstance);
            }
        } catch(e) {}
    }
    if (!isFirstMessage && stickyInstance && active.includes(stickyInstance)) return stickyInstance;

    // ⭐ FIX 05/05: ROUND-ROBIN puro — distribui igualmente entre todas as instâncias ativas.
    // Antes: score-based (mais ociosa vence) tendia a sobrecarregar 1 quando outras tinham histórico.
    // Agora: cada instância nova pega 1 cliente antes de repetir, ordem alfabética estável.
    if (isFirstMessage) {
        const sorted = [...active].sort();
        const chosen = sorted[_rrIndex % sorted.length];
        _rrIndex = (_rrIndex + 1) % sorted.length;
        try { addLog('LOAD_RR', `🔄 Round-robin [${sorted.join(', ')}] → ${chosen}`, { phoneKey, idx: _rrIndex }); } catch(e) {}
        return chosen;
    }

    return active[0];
}

// ============ ENVIO COM FALLBACK ============
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

    const active = getPoolForConversation(phoneKey);
    if (active.length === 0) { addLog('NO_INSTANCES', '⚠️ Sem instâncias ativas!'); return { success: false, error: 'NO_ACTIVE_INSTANCES' }; }

    const preferred = selectNextInstance(isFirstMessage, phoneKey);
    const stickyInstance = stickyInstances.get(phoneKey);
    let instancesToTry;

    // ⭐ FIX v1.2: Sticky usado também na primeira mensagem QUANDO conv vem de Start Trigger.
    // Garante que resposta sai do MESMO número que o cliente mandou a mensagem.
    // PIX/Aprovado/Abandono/Recusado NÃO setam startTriggerId, então mantêm comportamento original.
    const isFromStartTrigger = !!conversation.startTriggerId;

    // ⭐ v1.3 — GRACE PERIOD pra sticky offline
    // REGRA: Se cliente já tem sticky e essa instância caiu, NÃO migra automaticamente.
    // Aguarda o número voltar (até GRACE_PERIOD_DAYS dias). Se passar do prazo, libera pra novo número.
    const GRACE_PERIOD_DAYS = parseInt(process.env.GRACE_PERIOD_DAYS || '3');
    const stickyExistsButOffline = stickyInstance && !active.includes(stickyInstance);

    if (stickyExistsButOffline && !isFirstMessage) {
        // É continuação de funil (ex: passo 2, 3, 4...) e o sticky tá offline
        // Verifica se já passou do grace period
        let gracePassed = false;
        try {
            const conv = db.getDb().prepare(`
                SELECT sticky_instance, updated_at FROM conversations WHERE phone_key = ?
            `).get(phoneKey);
            if (conv && conv.updated_at) {
                const lastUpdate = new Date(conv.updated_at).getTime();
                const ageDays = (Date.now() - lastUpdate) / (1000 * 60 * 60 * 24);
                if (ageDays > GRACE_PERIOD_DAYS) gracePassed = true;
            }
        } catch(e) {}

        if (!gracePassed) {
            // ⏸️ AGUARDA O NÚMERO VOLTAR — não migra
            addLog('STICKY_WAIT', `⏸️ Sticky ${stickyInstance} offline. Aguardando voltar (grace ${GRACE_PERIOD_DAYS}d).`, { phoneKey });
            // Marca conversa como pausada (vai retomar quando instância voltar)
            const conv = conversations.get(phoneKey);
            if (conv) {
                conv.waitingForStickyReturn = true;
                conversations.set(phoneKey, conv);
            }
            return { success: false, waitingSticky: true, stickyInstance };
        } else {
            // 🔓 GRACE PERIOD EXPIROU — cliente liberado pra novo número
            addLog('STICKY_RELEASED', `🔓 Sticky ${stickyInstance} caído há +${GRACE_PERIOD_DAYS}d. Liberando ${phoneKey} pra novo número.`, { phoneKey });
            // Limpa sticky pra escolher fresh
            stickyInstances.delete(phoneKey);
            try { db.getDb().prepare('UPDATE conversations SET sticky_instance=NULL WHERE phone_key=?').run(phoneKey); } catch(e){}
        }
    }

    // Recalcula sticky após possível liberação acima
    const finalSticky = stickyInstances.get(phoneKey);

    if (finalSticky && active.includes(finalSticky) && (!isFirstMessage || isFromStartTrigger)) {
        instancesToTry = [finalSticky, ...active.filter(i => i !== finalSticky)];
    } else {
        // Cliente NOVO ou sticky liberado: usa o preferred (escolhido pelo balanceador)
        // IMPORTANTE: nunca tenta instância caída (active só lista as conectadas)
        instancesToTry = preferred ? [preferred, ...active.filter(i => i !== preferred)] : [...active];
    }

    for (const instanceName of instancesToTry) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                let result;
                if (step.type === 'text') result = await sendText(remoteJid, actualText, instanceName);
                else if (step.type === 'image') result = await sendImage(remoteJid, actualMediaUrl, '', instanceName);
                else if (step.type === 'image+text') result = await sendImage(remoteJid, actualMediaUrl, actualText, instanceName);
                else if (step.type === 'video') result = await sendVideo(remoteJid, actualMediaUrl, '', instanceName);
                else if (step.type === 'video+text') result = await sendVideo(remoteJid, actualMediaUrl, actualText, instanceName);
                else if (step.type === 'audio') result = await sendAudio(remoteJid, actualMediaUrl, instanceName);
                else if (step.type === 'sticker') result = await sendSticker(remoteJid, actualMediaUrl, instanceName);
                else if (step.type === 'viewonce_image') result = await sendViewOnce(remoteJid, actualMediaUrl, 'image', instanceName);
                else if (step.type === 'viewonce_video') result = await sendViewOnce(remoteJid, actualMediaUrl, 'video', instanceName);
                else result = { ok: true };

                if (result && result.ok) {
                    registerSentMessage(phoneKey, step, conversation);
                    const oldSticky = stickyInstances.get(phoneKey);
                    stickyInstances.set(phoneKey, instanceName);
                    // Persiste no banco para sobreviver reinicializações
                    try { db.getDb().prepare('UPDATE conversations SET sticky_instance=? WHERE phone_key=?').run(instanceName, phoneKey); } catch(e){}
                    if (!oldSticky) addLog('STICKY_SET', `📌 Instância fixada: ${instanceName}`, { phoneKey });
                    else if (oldSticky !== instanceName) addLog('STICKY_CHANGE', `🔄 Instância trocada: ${oldSticky}→${instanceName}`, { phoneKey });
                    db.updateInstanceStats(instanceName, 1);
                    db.updateInstanceHealth(instanceName, true);
                    // Contabiliza pelo NÚMERO (fonte da verdade) — se souber qual é
                    try {
                        const phoneRec = db.getPhoneNumberByInstance(instanceName);
                        if (phoneRec?.phone_number) db.incrementPhoneMessages(phoneRec.phone_number, 1);
                    } catch(e) {}
                    db.logMessage(phoneKey, 'out', actualText || actualMediaUrl, instanceName, step.id);
                    addLog('SEND_OK', `✅ Enviado via ${instanceName}`, { phoneKey, type: step.type });
                    sendSSE('message_sent', { phoneKey, instance: instanceName, stepType: step.type });
                    return { success: true, instanceName };
                }

                // Número inválido
                if (result.invalidNumber) {
                    addLog('INVALID_NUMBER', `❌ Número inválido: ${phoneKey} (${result.triedVariations || 1} variações testadas)`);
                    db.updateInstanceHealth(instanceName, false, true);
                    const conv = conversations.get(phoneKey);
                    if (conv) { conv.invalidNumber = true; conv.canceled = true; conversations.set(phoneKey, conv); }
                    return { success: false, invalidNumber: true };
                }
                db.updateInstanceHealth(instanceName, false, false);

                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                // ⭐ FIX 04/05: timeout/ECONNREFUSED não era registrado como down — instância ficava no cache falhando em silêncio
                db.updateInstanceHealth(instanceName, false, false);
                if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            }
        }
        // Esgotou as 3 tentativas nessa instância: verifica em background se ela caiu
        // (atualiza status/pool na hora, sem esperar o ciclo de 5min) e segue pra próxima.
        verifyInstanceAfterSendError(instanceName);
    }

    addLog('SEND_FAILED', `❌ Falha total para ${phoneKey}`);
    const conv = conversations.get(phoneKey);
    if (conv) { conv.hasError = true; conversations.set(phoneKey, conv); }
    return { success: false };
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

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location, pixExpiresAt, productsForSummary) {
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
            addLog('TEST_MODE_CANCEL', `🧪 Modo Teste: conversa anterior cancelada para ${phoneKey}`, { phoneKey });
        } else {
            addLog('PIX_BLOCKED', `Já existe para ${phoneKey} (funil ${existing.funnelType || existing.funnelId} ativo)`);
            return;
        }
    }

    // Anti-duplicata: se recebeu funil PIX para este produto recentemente, não dispara
    if (shouldBlockFunnelByCooldown(phoneKey, productId, 'PIX')) {
        db.recordEvent('PIX_GENERATED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: 'PIX', order_code: orderCode, order_bumps: orderBumps });
        sendSSE('pix_generated', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode, skipped: true });
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

    const conv = {
        phoneKey, remoteJid, funnelId: productId + '_PIX', stepIndex: -1, orderCode, customerName,
        productId, productName, orderBumps: orderBumps || [], amount, amountDisplay: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','),
        netValue, pixCode, checkoutUrl: generatedPixUrl, paymentMethod: paymentMethod || 'PIX',
        ddd: location?.ddd, city: location?.city, state: location?.state,
        waiting_for_response: false, pixWaiting: true,
        createdAt: new Date(), canceled: false, completed: false, paused: false
    };

    conversations.set(phoneKey, conv);
    registerPhoneUniversal(remoteJid, phoneKey);
    try { convToDb(phoneKey, conv); } catch(e) {} // persiste imediato pro rollback seguro

    db.recordEvent('PIX_GENERATED', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: 'PIX', order_code: orderCode, order_bumps: orderBumps });

    sendSSE('pix_generated', { phoneKey, customerName, productName, amount: conv.amountDisplay, netValue: netValue || amount, orderCode });
    {
        const notif = buildPaymentNotification('pix_generated', customerName, netValue || amount);
        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
    }
    addLog('PIX_WAITING', `⏳ PIX aguardando para ${phoneKey}`, { orderCode });

    const timeout = setTimeout(async () => {
        const c = conversations.get(phoneKey);
        if (c && c.orderCode === orderCode && !c.canceled && c.pixWaiting) {
            c.pixWaiting = false; c.stepIndex = 0;
            const selectedFunnel = selectABFunnel(productId, 'PIX');
            c.funnelId = selectedFunnel; c.abFunnelVariant = selectedFunnel;
            conversations.set(phoneKey, c);
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

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, orderBumps, paymentMethod, location) {
    const pixConv = conversations.get(phoneKey);
    const pixCode = pixConv?.pixCode;
    const existingSticky = stickyInstances.get(phoneKey);
    const abVariant = pixConv?.abFunnelVariant;

    if (pixConv) { pixConv.canceled = true; pixConv.canceledAt = new Date(); conversations.set(phoneKey, pixConv); }
    const pt = pixTimeouts.get(phoneKey);
    if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
    try { db.deletePixTimeout(phoneKey); } catch(e) {}

    db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps, funnel_id: abVariant });
    // ⭐ FIX 04/05: libera cooldown PIX desse produto agora que cliente pagou (permite recompra futura)
    try { db.clearFunnelReceiptOnPayment(phoneKey, productId); } catch(e) {}
    // ⭐ FIX 11/05: cliente pagou — cancela QUALQUER agendamento de recuperação pendente (proteção dupla)
    try {
        const cancelled = db.cancelScheduledFunnelsByPhone(phoneKey, 'cliente_pagou');
        if (cancelled > 0) addLog('RECOVERY_CANCEL_PAID_LIVE', `🚫 ${cancelled} agendamento(s) de recuperação cancelado(s) — cliente acabou de pagar`, { phoneKey });
    } catch(e) {}
    // Atualiza receita automática do dia para o módulo de investimentos
    try { db.updateDailyAutoRevenue(todayBR(), netValue || amount || 0); } catch(e) {}
    if (abVariant) db.recordABResult(abVariant, true);
    if (existingSticky) db.updateInstanceStats(existingSticky, 0, true);

    const amountDisplay = formatBRL(netValue || amount);
    sendSSE('payment_approved', { phoneKey, customerName, productName, amount: amountDisplay, netValue: netValue || amount, paymentMethod: paymentMethod || 'PIX' });
    {
        const isCard = paymentMethod === 'CREDIT_CARD';
        const notif = buildPaymentNotification(isCard ? 'card_paid' : 'pix_paid', customerName, netValue || amount);
        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
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
        productId, productName, orderBumps: orderBumps || [], amount, amountDisplay, netValue, pixCode,
        paymentMethod: paymentMethod || 'PIX', ddd: location?.ddd, city: location?.city, state: location?.state,
        waiting_for_response: false, createdAt: new Date(), lastSystemMessage: new Date(),
        canceled: false, completed: false, paused: false, transferredFromPix: true, abFunnelVariant: selectedFunnel
    };
    conversations.set(phoneKey, conv);
    registerPhoneUniversal(remoteJid, phoneKey);
    if (existingSticky) stickyInstances.set(phoneKey, existingSticky);
    db.recordABResult(selectedFunnel, false);
    db.recordFunnelReceipt(phoneKey, productId, 'APROVADA', selectedFunnel);
    // ⭐ 12/05: delay opcional pra 1ª msg APROVADA (default 0=instantâneo, configurável via APROVADA_DELAY_MS)
    await scheduleFirstStep(phoneKey, 'APROVADA');
}

async function startFunnel(phoneKey, remoteJid, funnelType, orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location, customFunnelId = null) {
    const existing = conversations.get(phoneKey);
    // ⭐ FIX 10/05: cliente que JÁ COMPLETOU funil anterior pode receber novo funil.
    // Só bloqueia se a conversa anterior ainda está ATIVA (não-cancelada E não-completa).
    if (existing && !existing.canceled && !existing.completed) {
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
            db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps });
        }
        addLog('FUNNEL_SKIPPED', `⏸️ ${funnelType} registrado mas funil não disparado (cooldown) para ${phoneKey}`, { orderCode });
        return;
    }

    if (funnelType === 'APROVADA') {
        db.recordEvent(paymentMethod === 'CREDIT_CARD' ? 'CARD_PAID' : 'PIX_PAID', { phone_key: phoneKey, product_id: productId, product_name: productName, amount, net_value: netValue, payment_method: paymentMethod || 'PIX', order_code: orderCode, order_bumps: orderBumps });
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
            const notif = buildPaymentNotification(isCard ? 'card_paid' : 'pix_paid', customerName, netValue || amount);
            await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
        }
    }

    // ⭐ FIX 11/05: aceita customFunnelId (usado por job de RECUPERAÇÃO pra forçar o funil escolhido no admin)
    const selectedFunnel = customFunnelId || selectABFunnel(productId, funnelType);
    const amountDisplay = 'R$ ' + (netValue || amount || 0).toFixed(2).replace('.', ',');
    const conv = {
        phoneKey, remoteJid, funnelId: selectedFunnel, stepIndex: 0, orderCode, customerName,
        productId, productName, orderBumps: orderBumps || [], amount, amountDisplay, netValue, pixCode,
        paymentMethod: paymentMethod || 'PIX', ddd: location?.ddd, city: location?.city, state: location?.state,
        waiting_for_response: false, createdAt: new Date(),
        canceled: false, completed: false, paused: false, abFunnelVariant: selectedFunnel,
        funnelType
    };
    conversations.set(phoneKey, conv);
    registerPhoneUniversal(remoteJid, phoneKey);
    db.recordABResult(selectedFunnel, false);
    db.recordFunnelReceipt(phoneKey, productId, funnelType, selectedFunnel);
    addLog('FUNNEL_START', `🚀 Iniciando ${selectedFunnel} para ${phoneKey}${customFunnelId ? ' (custom)' : ''}`, { orderCode });
    // ⭐ 12/05: delay opcional pra 1ª msg (default 0=instantâneo). ABANDONO usa ABANDONO_DELAY_MS, APROVADA usa APROVADA_DELAY_MS.
    await scheduleFirstStep(phoneKey, funnelType);
}

// ============ SEND STEP ============
// Helper: re-checa se a conversa foi cancelada/pausada/paga durante um await (evita enviar msg pra cliente que já pagou)
function isConvAlive(phoneKey) {
    const c = conversations.get(phoneKey);
    return c && !c.canceled && !c.completed && !c.paused && !c.invalidNumber;
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled || conversation.pixWaiting || conversation.paused || conversation.invalidNumber) return;

    // ⭐ FIX 06/26: além de viva, a conversa no Map precisa ser ESTA MESMA.
    // Quando o cliente paga no meio de um delay, transferPixToApproved() SUBSTITUI a conversa no Map
    // pela de APROVADA (que está viva) — isConvAlive(phoneKey) sozinho dizia "pode continuar" e a
    // mensagem de cobrança do PIX saía mesmo com o pagamento feito, ainda avançando o passo do funil errado.
    const stillCurrent = () => conversations.get(phoneKey) === conversation && isConvAlive(phoneKey);

    const funnel = db.getFunnelById(conversation.funnelId);
    if (!funnel || !funnel.steps?.length) { addLog('FUNNEL_EMPTY', `⚠️ ${conversation.funnelId} vazio`, { phoneKey }); return; }

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

    // Delay com variação aleatória
    if (step.delayBefore && parseInt(step.delayBefore) > 0) {
        const originalSecs = parseInt(step.delayBefore);
        const actualSecs = randomDelay(originalSecs);
        addLog('STEP_DELAY', `⏱️ delayBefore: ${originalSecs}s → ${actualSecs}s (±20%)`, { phoneKey });
        if (step.type !== 'delay' && step.type !== 'audio') {
            const sticky = stickyInstances.get(phoneKey) || getPoolForConversation(phoneKey)[0];
            if (sticky) await sendPresence(conversation.remoteJid, sticky, actualSecs);
        }
        await new Promise(r => setTimeout(r, actualSecs * 1000));
        // ⭐ FIX 04/05: Cliente pode ter pago durante o sleep — recheck antes de enviar msg de cobrança
        if (!stillCurrent()) { addLog('STEP_ABORT', `⏸️ Conversa morreu/foi substituída durante delay (provável pagamento)`, { phoneKey }); return; }
    } else if (step.showTyping && step.type !== 'delay') {
        const typingSecs = randomDelay(parseInt(step.typingSeconds || 3));
        const sticky = stickyInstances.get(phoneKey) || getPoolForConversation(phoneKey)[0];
        if (sticky) await sendPresence(conversation.remoteJid, sticky, typingSecs);
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
            conversation.awaitingPool = !stickyInstances.get(phoneKey);
            conversation.lastSendError = 'EXCEPTION';
            conversations.set(phoneKey, conversation);
            try { convToDb(phoneKey, conversation); } catch {}
            return;
        }
        if (result.blocked) {
            if (step.waitForReply) { conversation.waiting_for_response = false; conversations.set(phoneKey, conversation); }
            return;
        }
        if (result.invalidNumber) {
            // ⭐ FIX 04/05: garante reset do flag em número inválido (UI/recovery não acreditava no canceled)
            if (step.waitForReply) { conversation.waiting_for_response = false; conversations.set(phoneKey, conversation); }
            return;
        }

        // ⭐ FIX 04/05: falha de envio sem ser blocked/invalidNumber (pool vazio ou todas instâncias falharam)
        // Antes esse caminho deixava waiting_for_response=true e o lead ficava órfão pra sempre.
        // Agora reseta o flag, marca pra retry, e o checkInstancesHealth retoma quando instância voltar.
        if (!result.success) {
            if (step.waitForReply) conversation.waiting_for_response = false;
            conversation.hasError = true;
            // awaitingPool: marca leads sem sticky (1ª msg) que falharam por pool vazio/todas down — retomar quando QUALQUER instância voltar
            conversation.awaitingPool = !stickyInstances.get(phoneKey);
            conversation.lastSendError = result.error || (result.waitingSticky ? 'STICKY_OFFLINE' : 'SEND_FAILED');
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
        if (conversations.get(phoneKey) !== conversation) {
            addLog('STEP_ABORT', `⏸️ Conversa substituída durante envio — não avança passo`, { phoneKey });
            return;
        }
        conversation.lastSystemMessage = new Date();
        conversations.set(phoneKey, conversation);
        if (step.waitForReply && step.type !== 'delay') {
            addLog('STEP_WAIT', `⏸️ Aguardando resposta (passo ${conversation.stepIndex + 1})`, { phoneKey });
        } else {
            await advanceConversation(phoneKey, null, 'auto');
        }
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    if (!conversation || conversation.canceled || conversation.paused) return;

    // Verifica gatilhos globais na resposta
    if (reason === 'reply' && replyText) {
        const trigger = checkTriggers(replyText, conversation);
        if (trigger) {
            addLog('TRIGGER_ACTION', `🎯 Executando gatilho: ${trigger.name}`, { phoneKey, autoBlock: trigger.auto_block });

            if (trigger.auto_block) {
                const sticky = stickyInstances.get(phoneKey);
                if (sticky) await blockContact(conversation.remoteJid, sticky);
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

// ============ VERIFICAÇÃO DE INSTÂNCIAS ============
// ⭐ FIX 04/05: flag de reentrância. Se um tick demora >30s (10 instâncias x 8s timeout), próximo tick não entra paralelo.
let _healthRunning = false;
async function checkInstancesHealth() {
    if (_healthRunning) return;
    _healthRunning = true;
    try { return await _checkInstancesHealthInner(); }
    finally { _healthRunning = false; }
}
async function _checkInstancesHealthInner() {
    const instances = db.getInstances();
    let changed = false;
    for (const inst of instances) {
        if (inst.paused) continue;
        if (!inst.name || !inst.name.trim()) continue; // ignora instâncias sem nome válido
        const connected = await checkInstanceConnected(inst.name);

        // Se conectado: busca o número atual do WhatsApp nessa instância (pra saber que número está ali)
        let currentPhone = null;
        if (connected) {
            currentPhone = await fetchInstanceOwnerNumber(inst.name);
            if (currentPhone) {
                // Registra/atualiza o número no sistema (com a instância onde ele está)
                try { db.upsertPhoneNumber(currentPhone, { instance: inst.name }); } catch(e) {}
            }
        }

        if (connected !== !!inst.connected) {
            db.setInstanceConnected(inst.name, connected);
            changed = true;
            if (!connected) {
                // Qual número estava nessa instância antes de cair?
                const lastPhone = db.getPhoneNumberByInstance(inst.name);
                const phoneInfo = lastPhone || {};

                // Monta info de identificação (prioriza dados do phone, depois da instância)
                const idParts = [];
                const deviceName = phoneInfo.device_name || inst.device_name;
                const deviceSlot = phoneInfo.device_slot || inst.device_slot;
                const phoneNum = phoneInfo.phone_number || inst.phone_number;
                const accountType = phoneInfo.account_type || inst.account_type;

                if (deviceName) idParts.push(`📱 ${deviceName}`);
                if (deviceSlot) idParts.push(`🔹 ${deviceSlot}`);
                if (phoneNum) idParts.push(`📞 ${phoneNum}`);
                if (accountType) idParts.push(`(${accountType})`);
                const idText = idParts.length ? '\n' + idParts.join(' · ') : '';

                // Registra queda do número (tipo UNKNOWN — você classifica depois)
                if (phoneInfo.phone_number) {
                    try { db.recordPhoneDrop(phoneInfo.phone_number, inst.name, 'UNKNOWN'); } catch(e) {}
                }

                // Sem notificação: queda/retorno de instância só atualiza o status na tela e os registros internos.
                addLog('INSTANCE_DOWN', `🔴 ${inst.name} caiu!${idText ? ' ' + idParts.join(' · ') : ''}`);
                sendSSE('instance_down', { name: inst.name, phone: phoneInfo.phone_number });
            } else {
                // Voltou — marca recovery no número que está agora (pode ser o mesmo ou outro)
                if (currentPhone) {
                    try { db.recordPhoneRecovery(currentPhone); } catch(e) {}
                }
                addLog('INSTANCE_UP', `🟢 ${inst.name} voltou!${currentPhone ? ' 📞 ' + currentPhone : ''}`);
                sendSSE('instance_up', { name: inst.name, phone: currentPhone });

                // ⭐ v1.3: Retoma conversas que estavam aguardando essa instância voltar
                let resumedCount = 0;
                for (const [phoneKey, conv] of conversations.entries()) {
                    if (conv.waitingForStickyReturn && stickyInstances.get(phoneKey) === inst.name) {
                        conv.waitingForStickyReturn = false;
                        conversations.set(phoneKey, conv);
                        resumedCount++;
                        // Agenda retomada do passo atual em ~5s (escalonado pra não estourar)
                        setTimeout(() => {
                            try { sendStep(phoneKey); } catch(e) {}
                        }, 5000 + (resumedCount * 1500));
                    }
                }
                if (resumedCount > 0) {
                    addLog('STICKY_RESUME', `▶️ ${resumedCount} conversa(s) retomadas via ${inst.name}`);
                }

                // ⭐ FIX 04/05: Retoma TAMBÉM órfãos (awaitingPool) — rate limit 30s pra não sobrecarregar a instância que acabou de voltar.
                // ⭐ 15/05: Cutoff curto pra ABANDONO (2h). Antes era 24h pra tudo — causava carpet bombing pós-viagem.
                //          PIX/APROVADA/outros mantêm 24h porque tão funcionando 100%.
                const ORPHAN_CUTOFF = Date.now() - (24 * 60 * 60 * 1000);
                const ORPHAN_CUTOFF_ABANDONO = Date.now() - (2 * 60 * 60 * 1000);
                let orphanResumed = 0;
                let orphanSkippedAbandono = 0;
                for (const [phoneKey, conv] of conversations.entries()) {
                    if (!conv.awaitingPool) continue;
                    if (conv.canceled || conv.completed || conv.paused || conv.invalidNumber) continue;
                    const createdAt = conv.createdAt ? new Date(conv.createdAt).getTime() : 0;
                    const isAbandono = conv.funnelType === 'ABANDONO';
                    const cutoff = isAbandono ? ORPHAN_CUTOFF_ABANDONO : ORPHAN_CUTOFF;
                    if (createdAt < cutoff) {
                        if (isAbandono) orphanSkippedAbandono++;
                        continue;
                    }
                    // ⭐ 15/05: Respeita toggle global de abandono — se DESLIGADO, não retoma órfãos de abandono.
                    if (isAbandono && !isAbandonoEnabled()) {
                        orphanSkippedAbandono++;
                        continue;
                    }
                    conv.awaitingPool = false;
                    conv.hasError = false;
                    conv.waiting_for_response = false;
                    conversations.set(phoneKey, conv);
                    orphanResumed++;
                    setTimeout(() => { try { sendStep(phoneKey); } catch(e) {} }, 10000 + (orphanResumed * 30000));
                }
                if (orphanResumed > 0) {
                    addLog('ORPHAN_RESUME', `🔁 ${orphanResumed} órfão(s) agendados via ${inst.name} (1 a cada 30s)`);
                }
                if (orphanSkippedAbandono > 0) {
                    addLog('ORPHAN_SKIP_ABANDONO', `⏭️ ${orphanSkippedAbandono} abandono(s) pulado(s) (>2h ou toggle OFF) — use o app pra disparar/limpar manualmente`);
                }
            }
        }
    }
    if (changed) refreshInstanceCache();
}
// Verificação silenciosa a cada 5min (era 30s) — só atualiza status na tela e retoma leads travados.
// Quedas detectadas na hora do envio disparam verificação imediata via verifyInstanceAfterSendError().
setInterval(checkInstancesHealth, 5 * 60 * 1000);

// Verificação sob demanda: quando um envio falha, confere na hora se a instância caiu,
// atualiza o status e tira ela do pool imediatamente (sem esperar o ciclo de 5min).
// Debounce de 60s por instância pra rajada de falhas não virar rajada de requisições.
const _lastErrorCheck = new Map();
async function verifyInstanceAfterSendError(instanceName) {
    try {
        if (!instanceName) return;
        const last = _lastErrorCheck.get(instanceName) || 0;
        if (Date.now() - last < 60000) return;
        _lastErrorCheck.set(instanceName, Date.now());
        const connected = await checkInstanceConnected(instanceName);
        const inst = db.getInstances().find(i => i.name === instanceName);
        if (inst && connected !== !!inst.connected) {
            db.setInstanceConnected(instanceName, connected);
            refreshInstanceCache();
            addLog(connected ? 'INSTANCE_UP' : 'INSTANCE_DOWN', `${connected ? '🟢' : '🔴'} ${instanceName} ${connected ? 'voltou' : 'caiu'} (detectado no envio)`);
            sendSSE(connected ? 'instance_up' : 'instance_down', { name: instanceName });
        }
    } catch(e) {}
}

// ⭐ FIX 11/05: Job de RECUPERAÇÃO 24h pós-completar PIX/ABANDONO
// A cada 1min, processa scheduled_funnels pendentes. Triple-guarded:
//   1. cliente já pagou (hasEverPaid)        → cancela
//   2. cliente em outro funil ativo          → cancela
//   3. cliente em blacklist                  → cancela
let _recoveryJobRunning = false;
async function processScheduledFunnels() {
    if (_recoveryJobRunning) return;
    _recoveryJobRunning = true;
    try {
        const pending = db.getPendingScheduledFunnels();
        if (!pending.length) return;
        addLog('RECOVERY_JOB', `⚙️ Processando ${pending.length} agendamento(s) de recuperação`);
        for (const s of pending) {
            try {
                // PROTEÇÃO 1: cliente JÁ PAGOU alguma vez? CANCELA — não oferece desconto pra cliente pagante
                if (db.hasEverPaid(s.phone_key)) {
                    db.cancelScheduledFunnel(s.id, 'cliente_ja_pagou');
                    addLog('RECOVERY_CANCEL_PAID', `🚫 Recuperação cancelada — ${s.customer_name || s.phone_key} já pagou alguma vez`, { phoneKey: s.phone_key });
                    continue;
                }
                // PROTEÇÃO 2: cliente em funil ativo? CANCELA
                if (hasActiveFunnelConversation(s.phone_key)) {
                    db.cancelScheduledFunnel(s.id, 'funil_ativo');
                    const ft = getActiveFunnelType(s.phone_key);
                    addLog('RECOVERY_CANCEL_ACTIVE', `🚫 Recuperação cancelada — ${s.customer_name || s.phone_key} já em ${ft}`, { phoneKey: s.phone_key });
                    continue;
                }
                // PROTEÇÃO 3: blacklist? CANCELA
                if (db.isBlacklisted(s.phone_key)) {
                    db.cancelScheduledFunnel(s.id, 'blacklist');
                    addLog('RECOVERY_CANCEL_BL', `🚫 Recuperação cancelada — ${s.phone_key} na blacklist`, { phoneKey: s.phone_key });
                    continue;
                }
                // PROTEÇÃO 4: funil destino existe e tem passos? CANCELA se quebrado
                const targetFunnel = db.getFunnelById(s.funnel_id);
                if (!targetFunnel || !targetFunnel.steps?.length) {
                    db.cancelScheduledFunnel(s.id, 'funil_destino_invalido');
                    addLog('RECOVERY_CANCEL_FUNNEL', `🚫 Funil destino "${s.funnel_id}" não existe ou está vazio`, { phoneKey: s.phone_key });
                    continue;
                }
                // DISPARA — usa startFunnel com customFunnelId pra forçar o funil escolhido pelo Danilo
                const location = { ddd: null, city: null, state: null }; // location seria recuperada pelo phoneKey se precisar
                await startFunnel(
                    s.phone_key,
                    s.remote_jid,
                    'RECUPERACAO',
                    'REMARK_' + Date.now(),
                    s.customer_name || 'Cliente',
                    s.product_id || 'GRUPO_VIP',
                    s.product_name || 'GRUPO VIP',
                    0, 0, null, [],
                    'PIX',
                    location,
                    s.funnel_id // ← customFunnelId
                );
                db.markScheduledFunnelFired(s.id);
                addLog('RECOVERY_FIRED', `🚀 Recuperação disparada pra ${s.customer_name || s.phone_key} (origem: ${s.trigger_source})`, { phoneKey: s.phone_key, scheduleId: s.id });
            } catch(e) {
                addLog('RECOVERY_FIRE_ERR', `Erro disparando recovery #${s.id}: ${e.message}`, { phoneKey: s.phone_key });
                // não marca como fired pra tentar de novo no próximo tick
            }
        }
    } catch(e) {
        addLog('RECOVERY_JOB_ERR', `Erro no job de recuperação: ${e.message}`);
    } finally {
        _recoveryJobRunning = false;
    }
}
setInterval(processScheduledFunnels, 60 * 1000); // 1min

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
        const mainOfferId = (data.products || []).find(p => !p.is_order_bump)?.offer_id;
        const productDb = mainOfferId ? db.getProductByOfferId(mainOfferId) : null;
        const productId = productDb?.id || 'GRUPO_VIP';
        const productName = productDb?.name || 'GRUPO VIP';

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

        if (isApproved) {
            const existingConv = findConversationUniversal(customerPhone);
            if (existingConv?.funnelId?.includes('_PIX')) {
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, orderBumps, paymentMethod, location);
            } else {
                const pt = pixTimeouts.get(phoneKey); if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
                await startFunnel(phoneKey, remoteJid, 'APROVADA', orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location);
            }
            // Repassa pro LinkRotator (sem await — fire-and-forget)
            relayToLinkRotator(isCard ? 'CARD_PAID' : 'SALE_APPROVED', relayPayload);
        } else if (isRefused && isCard) {
            // ⭐ FIX 10/05: cartão recusado só dispara se cliente NÃO está em funil ativo
            const activeType = getActiveFunnelType(phoneKey);
            if (activeType) {
                addLog('CARD_REFUSED_IGNORED', `💳❌ Cartão recusado IGNORADO — cliente já em ${activeType} (${customerName})`, { orderCode, phoneKey });
            } else {
                addLog('CARD_REFUSED', `💳❌ Cartão recusado: ${customerName}`, { orderCode, phoneKey });
                {
                    const notif = buildPaymentNotification('card_refused', customerName, netValue || amount);
                    await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
                }
                await startFunnel(phoneKey, remoteJid, 'CARTAO_RECUSADO', orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, 'CREDIT_CARD', location);
            }
        } else if (isAbandoned) {
            // ⭐ 15/05: Toggle global — se DESLIGADO, registra em events/log mas não dispara nada.
            // Funis em andamento NÃO são tocados (regra: só bloqueia NOVOS).
            if (!isAbandonoEnabled()) {
                addLog('ABANDONED_DISABLED', `🚫 Abandono DESLIGADO — ${customerName} ignorado (toggle global OFF)`, { orderCode, phoneKey });
                // SEM SSE/notif/push — silencioso
            } else {
                // ⭐ FIX 10/05: ABANDONED só dispara (notif + funil) se cliente NÃO está em outro funil ativo.
                // Regra do Danilo: cliente em PIX/ABANDONO/etc só é interrompido por APROVADA.
                const activeType = getActiveFunnelType(phoneKey);
                if (activeType) {
                    addLog('ABANDONED_IGNORED', `🛒 Carrinho abandonado IGNORADO — cliente já em ${activeType} (${customerName})`, { orderCode, phoneKey });
                    // SEM notif/SSE/push — silencioso pra não confundir o Danilo
                } else {
                    addLog('ABANDONED', `🛒 Carrinho abandonado: ${customerName}`, { orderCode, phoneKey });
                    // ⭐ FIX 05/05: SSE pra tocar som no painel quando carrinho abandonado chega
                    sendSSE('cart_abandoned', { phoneKey, customerName, productName, amount: 'R$ ' + (amount || 0).toFixed(2).replace('.', ','), netValue: netValue || amount, orderCode });
                    // ⭐ FIX 10/05: push notification no celular com emoji 🛒 distinto (iPhone web push)
                    {
                        const notif = buildPaymentNotification('cart_abandoned', customerName, amount);
                        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
                    }
                    await startFunnel(phoneKey, remoteJid, 'ABANDONO', orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, paymentMethod, location);
                }
            }
        } else if (isPix && event.includes('GENERATED')) {
            // ⭐ FIX 10/05: PIX_GENERATED só dispara se cliente NÃO está em outro funil ativo (que não seja PIX_WAITING).
            // Se já está em ABANDONO/CARTAO_RECUSADO/etc, ignora (regra de exclusividade).
            const activeType = getActiveFunnelType(phoneKey);
            if (activeType && activeType !== 'PIX_WAITING' && activeType !== 'PIX') {
                addLog('PIX_GENERATED_IGNORED', `⏳ PIX_GENERATED IGNORADO — cliente já em ${activeType} (${customerName})`, { orderCode, phoneKey });
                // SEM notif/SSE/push (silencioso)
            } else {
                // A checagem de "já existe" do mesmo tipo é feita dentro de createPixWaitingConversation
                // (que também respeita o Modo Teste, cancelando a anterior automaticamente)
                await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productId, productName, amount, netValue, pixCode, orderBumps, 'PIX', location, pixExpiresAt, productsForSummary);
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
        const ppEvent = statusEnum === 2 ? 'SALE_APPROVED' : (statusEnum === 1 ? 'PIX_GENERATED' : `STATUS_${statusEnum}`);

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
                order_bumps: []
            });

            const existingConv = findConversationUniversal(customerPhone);
            if (existingConv?.funnelId?.includes('_PIX')) {
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productId, productName, saleAmount, netValue, [], paymentMethod, location);
            } else {
                const pt = pixTimeouts.get(phoneKey); if (pt) { clearTimeout(pt.timeout); pixTimeouts.delete(phoneKey); }
                await startFunnel(phoneKey, remoteJid, 'APROVADA', orderCode, customerName, productId, productName, saleAmount, netValue, pixCode, [], paymentMethod, location);
            }
            res.json({ success: true });
        } else if (statusEnum === 1 && !isCard) {
            // ⭐ FIX 10/05: PIX_GENERATED só processa se cliente NÃO está em outro funil ativo
            const activeType = getActiveFunnelType(phoneKey);
            if (activeType && activeType !== 'PIX_WAITING' && activeType !== 'PIX') {
                addLog('PP_PIX_GENERATED_IGNORED', `⏳ PIX_GENERATED IGNORADO — cliente já em ${activeType} (${customerName})`, { orderCode, phoneKey });
                return res.json({ success: true, ignored: 'active_funnel' });
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
                order_bumps: []
            });
            // A checagem de "já existe" é feita dentro de createPixWaitingConversation (respeita Modo Teste)
            // ⭐ FIX 10/05: passar pixExpiresAt + productsForSummary (faltavam — página PIX caía em 24h fixo e resumo vazio)
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productId, productName, saleAmount, netValue, pixCode, [], 'PIX', location, pixExpiresAt, ppProductsForSummary);
            res.json({ success: true });
        } else res.json({ success: true });
        } finally { releaseWebhookLock(phoneKey); }
    } catch (error) { addLog('PERFECTPAY_ERR', error.message); res.status(500).json({ success: false }); }
});

// ⭐ FIX 10/05: dedup de webhook Evolution por key.id (Evolution retenta — mesma mensagem pode chegar 2-3x)
// TTL 5min. Map cleanup automático ao crescer (>5000 entries) pra evitar leak.
const _evolutionWebhookSeen = new Map();
function isDuplicateEvolutionWebhook(messageKey) {
    const id = messageKey?.id;
    if (!id) return false;
    const now = Date.now();
    const seen = _evolutionWebhookSeen.get(id);
    if (seen && (now - seen) < 5 * 60 * 1000) return true;
    _evolutionWebhookSeen.set(id, now);
    if (_evolutionWebhookSeen.size > 5000) {
        const cutoff = now - 5 * 60 * 1000;
        for (const [k, t] of _evolutionWebhookSeen.entries()) {
            if (t < cutoff) _evolutionWebhookSeen.delete(k);
        }
    }
    return false;
}

app.post('/webhook/evolution', async (req, res) => {
    try {
        // ⭐ FIX 10/05: token opcional via env (Evolution não tem HMAC nativo, então usa shared token).
        // Sem o token configurado, mantém comportamento atual (compat). Quando configurar, exige.
        if (EVOLUTION_WEBHOOK_TOKEN) {
            const provided = req.query.t || req.headers['x-evolution-token'] || req.headers['x-webhook-token'] || '';
            if (!timingSafeStringCompare(String(provided), EVOLUTION_WEBHOOK_TOKEN)) {
                addLog('EVO_AUTH_FAIL', '🚫 Webhook Evolution sem token válido — rejeitado');
                return res.status(401).json({ success: false, message: 'invalid token' });
            }
        }
        const data = req.body;
        const event = data.event;
        if (event && !event.includes('message')) return res.json({ success: true });
        const messageData = data.data;
        if (!messageData?.key) return res.json({ success: true });
        // ⭐ FIX 10/05: dedup por key.id (Evolution retenta — mesma mensagem chega 2-3x = advanceConversation duplicado)
        if (isDuplicateEvolutionWebhook(messageData.key)) {
            return res.json({ success: true, deduped: true });
        }
        const remoteJid = messageData.key.remoteJid;
        if (messageData.key.fromMe) return res.json({ success: true });
        const messageText = extractMessageText(messageData.message);
        // Nome da instância (Evolution API envia em data.instance)
        const incomingInstanceName = data.instance || data.instanceName || messageData.instanceName || null;
        const isLid = remoteJid.includes('@lid');
        let phoneToSearch = remoteJid;
        if (isLid) {
            if (messageData.key.participant) phoneToSearch = messageData.key.participant;
            else { const mk = lidMapping.get(remoteJid); if (mk) { const mc = conversations.get(mk); if (mc) phoneToSearch = mc.remoteJid; } }
        }
        const incomingPhone = phoneToSearch.split('@')[0];
        const phoneKey = normalizePhoneKey(incomingPhone);
        if (!phoneKey || phoneKey.length !== 8) return res.json({ success: true });
        if (db.isBlacklisted(phoneKey)) return res.json({ success: true });

        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) return res.json({ success: false });

        try {
            const conversation = findConversationUniversal(phoneToSearch);
            if (conversation && isLid) registerLidMapping(remoteJid, conversation.phoneKey);

            // Verifica reativação de lead antigo
            if (!conversation || conversation.canceled || conversation.completed) {
                const history = db.getCompletedConversationsByPhone(phoneKey);
                if (history.length > 0) {
                    const lastConv = history[0];
                    const daysSince = (Date.now() - new Date(lastConv.created_at).getTime()) / 86400000;
                    const reactivationDays = parseInt(process.env.REACTIVATION_DAYS || '3');
                    if (daysSince >= reactivationDays) {
                        const reactivationFunnel = process.env.REACTIVATION_FUNNEL_ID || (lastConv.product_id + '_REATIVACAO');
                        const reactivFunnel = db.getFunnelById(reactivationFunnel);
                        if (reactivFunnel) {
                            addLog('REACTIVATION', `♻️ Reativando lead antigo: ${phoneKey}`, { daysSince: Math.round(daysSince) });
                            const reactivConv = {
                                phoneKey, remoteJid: phoneToSearch,
                                funnelId: reactivationFunnel, stepIndex: 0,
                                orderCode: 'REATIV_' + Date.now(),
                                customerName: lastConv.customer_name,
                                productId: lastConv.product_id, productName: lastConv.product_name,
                                orderBumps: [], amount: 0, amountDisplay: '', netValue: 0,
                                ddd: lastConv.ddd, city: lastConv.city, state: lastConv.state,
                                waiting_for_response: false, createdAt: new Date(),
                                canceled: false, completed: false, paused: false, reactivation: true
                            };
                            conversations.set(phoneKey, reactivConv);
                            registerPhoneUniversal(phoneToSearch, phoneKey);
                            await sendStep(phoneKey);
                            return res.json({ success: true });
                        }
                    }
                }

                // ============ START TRIGGERS (gatilho de início para lead novo) ============
                // Verifica se a mensagem dispara algum funil novo via palavra-chave.
                // Falha silenciosa: se algo der errado, segue pro EVO_IGNORED original.
                try {
                    const startTrigger = checkStartTriggers(messageText, incomingInstanceName);
                    if (startTrigger) {
                        const location = db.getLocationFromPhone(incomingPhone);
                        const started = await startConversationFromTrigger(startTrigger, phoneKey, phoneToSearch, location, incomingInstanceName);
                        if (started) return res.json({ success: true });
                    }
                } catch(stErr) {
                    addLog('START_TRIGGER_FAIL', `⚠️ Erro start_trigger (seguindo fluxo): ${stErr.message}`);
                }

                addLog('EVO_IGNORED', `Sem conversa ativa para ${phoneKey}`);
                return res.json({ success: true });
            }

            if (conversation.pixWaiting || conversation.paused || conversation.invalidNumber) return res.json({ success: true });
            
            // Garante que estamos usando a conversa mais atualizada da memória
            const freshConv = conversations.get(conversation.phoneKey) || conversation;
            if (!freshConv.waiting_for_response) { 
                addLog('NOT_WAITING', `⚠️ Não aguardando — ignorando (${conversation.phoneKey})`, { phoneKey }); 
                return res.json({ success: true }); 
            }
            // Atualiza referência para a conversa fresca
            Object.assign(conversation, freshConv);

            db.logMessage(phoneKey, 'in', messageText, null, null);
            db.processWordFrequency(messageText, conversation.productId);
            addLog('CLIENT_REPLY', `✅ Resposta: "${messageText.substring(0, 50)}"`, { phoneKey });
            sendSSE('client_reply', { phoneKey, text: messageText.substring(0, 100) });
            await advanceConversation(phoneKey, messageText, 'reply');
            res.json({ success: true });
        } finally { releaseWebhookLock(phoneKey); }
    } catch (error) { addLog('EVO_ERR', error.message); res.status(500).json({ success: false }); }
});

// ============ PIX PAGE PÚBLICA ============
app.get('/pix/:token', (req, res) => {
    const page = db.getPixPage(req.params.token);
    if (!page) return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Link inválido</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;color:#333}</style></head><body><div style="text-align:center"><h2>Link inválido ou expirado</h2><p>Este link não existe ou já expirou.</p></div></body></html>`);

    const expired = new Date(page.expires_at) < new Date();
    const prod = page.product_id ? db.getProducts().find(p => p.id === page.product_id) : null;

    const title = prod?.pix_page_title || 'Finalize o pagamento para liberar seu acesso';
    const modelName = prod?.pix_page_model_name || '';
    const overlayText = prod?.pix_page_overlay_text || (modelName ? `Voce acabou de ganhar uma chamadinha com a ${modelName}. Finalize o pagamento para resgatar!` : '');
    const mediaUrl = prod?.pix_page_media_url || '';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&data=${encodeURIComponent(page.pix_code)}`;

    // Resumo do pedido (lista de produtos + total). Se não tiver products_json, mostra fallback simples.
    let products = [];
    try { products = JSON.parse(page.products_json || '[]'); } catch(e) {}
    const fmtBRL = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
    const totalValue = products.length ? products.reduce((s, p) => s + (Number(p.price) || 0), 0) : null;
    const summaryHtml = products.length
        ? `<div class="summary">
              <div class="summary-h">Resumo do pedido</div>
              ${products.map(p => `
                <div class="summary-item ${p.is_bump ? 'bump' : 'main'}">
                  <span>${p.name}</span>
                  <span class="price">${fmtBRL(p.price)}</span>
                </div>`).join('')}
              <div class="summary-divider"></div>
              <div class="summary-total">
                <span>Total a pagar</span>
                <span class="total-value">${fmtBRL(totalValue)}</span>
              </div>
           </div>`
        : (page.amount_display
            ? `<div class="summary">
                  <div class="summary-h">Resumo do pedido</div>
                  <div class="summary-item main">
                    <span>${page.product_name || 'Produto'}</span>
                    <span class="price">${page.amount_display}</span>
                  </div>
                  <div class="summary-divider"></div>
                  <div class="summary-total">
                    <span>Total a pagar</span>
                    <span class="total-value">${page.amount_display}</span>
                  </div>
               </div>`
            : '');

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
  .model-wrap{width:100%;height:320px;overflow:hidden;background:#111;opacity:0;transition:opacity .8s ease;position:relative;}
  .model-wrap.visible{opacity:1;}
  .model-img{width:100%;height:100%;object-fit:cover;object-position:center top;display:block;filter:blur(10px) brightness(0.65);transform:scale(1.08);}
  .model-overlay{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(0,0,0,0.35) 0%,rgba(0,0,0,0.1) 40%,rgba(0,0,0,0.65) 100%);}
  .model-live{position:absolute;top:14px;left:14px;display:flex;align-items:center;gap:6px;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.15);color:#fff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:6px 12px;border-radius:100px;}
  .live-dot{width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 6px #ef4444;animation:blink 1.2s infinite;}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0.15}}
  .model-text{position:absolute;bottom:0;left:0;right:0;padding:20px 20px 24px;text-align:center;}
  .model-tag{display:inline-block;background:rgba(255,255,255,0.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.25);color:#fff;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;padding:5px 14px;border-radius:100px;margin-bottom:10px;}
  .model-cta{font-size:17px;font-weight:900;color:#fff;line-height:1.3;letter-spacing:-0.2px;text-shadow:0 2px 16px rgba(0,0,0,0.7);}
  .body{padding:28px 20px 0;max-width:480px;margin:0 auto;}
  .headline{font-size:22px;font-weight:800;color:#111;line-height:1.2;letter-spacing:-0.3px;margin-bottom:6px;text-align:center;}
  .subline{font-size:14px;color:#6b7280;line-height:1.5;margin-bottom:24px;text-align:center;font-weight:500;}
  .cd-wrap{text-align:center;margin-bottom:24px;}
  .cd-label{font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:8px;}
  .cd-timer{font-size:32px;font-weight:800;color:#111;font-variant-numeric:tabular-nums;letter-spacing:3px;line-height:1;margin-bottom:10px;}
  .cd-timer.urgent{color:#dc2626;animation:pulse .5s infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.2}}
  .cd-bar-wrap{height:4px;background:#f3f4f6;border-radius:100px;overflow:hidden;}
  .cd-bar{height:100%;background:#111;border-radius:100px;width:100%;transition:width 1s linear;}
  .cd-bar.urgent{background:#dc2626;}
  .divider{height:1px;background:#f3f4f6;margin:20px 0;}
  .summary{background:#fafafa;border:1px solid #f3f4f6;border-radius:12px;padding:16px 18px;margin-bottom:22px;}
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
  .qr-wrap{display:flex;justify-content:center;margin-bottom:14px;}
  .qr-box{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:inline-block;}
  .pix-code{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:13px 15px;font-size:10px;color:#9ca3af;word-break:break-all;line-height:1.6;max-height:60px;overflow:hidden;position:relative;margin-bottom:12px;}
  .pix-code::after{content:'';position:absolute;bottom:0;left:0;right:0;height:24px;background:linear-gradient(transparent,#f9fafb);}
  .expired-msg{background:#fee2e2;border:1px solid #fecaca;color:#dc2626;border-radius:12px;padding:14px;text-align:center;font-size:14px;font-weight:600;margin-bottom:16px;}
  .btn{width:100%;padding:20px;background:#111;color:#fff;border:none;border-radius:14px;font-size:15px;font-weight:800;cursor:pointer;letter-spacing:0.3px;position:relative;overflow:hidden;margin-bottom:28px;transition:transform .1s;box-shadow:0 4px 24px rgba(0,0,0,0.12);}
  .btn::after{content:'';position:absolute;top:0;left:-100%;width:50%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.07),transparent);animation:shine 2.5s infinite;}
  @keyframes shine{to{left:150%}}
  .btn:active{transform:scale(0.98);}
  .btn.ok{background:#15803d;box-shadow:0 4px 24px rgba(21,128,61,0.2);}
  .btn.ok::after{display:none;}
  .steps-label{font-size:11px;font-weight:700;color:#d1d5db;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px;}
  .steps{display:flex;flex-direction:column;gap:12px;margin-bottom:28px;}
  .step{display:flex;align-items:flex-start;gap:12px;}
  .step-n{width:22px;height:22px;border-radius:50%;border:1.5px solid #e5e7eb;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;color:#9ca3af;}
  .step-t{font-size:13px;color:#6b7280;line-height:1.45;}
  .step-t strong{color:#111;font-weight:700;}
  .footer{text-align:center;font-size:11px;color:#d1d5db;padding-top:16px;border-top:1px solid #f3f4f6;}
</style>
</head>
<body>
${mediaUrl ? `
<div class="model-wrap" id="modelWrap">
  <img class="model-img" src="${mediaUrl}" alt="">
  <div class="model-overlay"></div>
  ${modelName ? `<div class="model-live"><div class="live-dot"></div>AO VIVO · ${modelName}</div>` : ''}
  ${overlayText ? `<div class="model-text"><div class="model-tag">Presente desbloqueado</div><div class="model-cta">${overlayText}</div></div>` : ''}
</div>` : ''}
<div class="body">
  <div class="headline">${title}</div>
  <div class="subline">Finalize antes do tempo acabar e receba bonus exclusivos</div>
  <div class="cd-wrap">
    <div class="cd-label">Finalize antes do tempo acabar e receba bonus</div>
    <div class="cd-timer" id="timer">${expired ? '00:00' : '03:00'}</div>
    <div class="cd-bar-wrap"><div class="cd-bar ${expired ? 'urgent' : ''}" id="cdBar" style="${expired ? 'width:0%' : ''}"></div></div>
  </div>
  <div class="divider"></div>
  ${summaryHtml}
  ${expired ? '<div class="expired-msg">Este link expirou. Gere um novo PIX no checkout.</div>' : `
  <div class="qr-wrap"><div class="qr-box"><img src="${qrUrl}" width="160" height="160" alt="QR Code PIX" style="display:block;border-radius:4px;"></div></div>
  <div class="pix-code" id="pixBox">${page.pix_code}</div>
  <button class="btn" id="btnPix" onclick="copyPix()">CLIQUE AQUI PARA COPIAR O PIX</button>`}
  <div class="steps-label">Como pagar</div>
  <div class="steps">
    <div class="step"><div class="step-n">1</div><div class="step-t">Abra o <strong>app do seu banco</strong></div></div>
    <div class="step"><div class="step-n">2</div><div class="step-t">Va em <strong>Pix — Pagar — Copia e Cola</strong></div></div>
    <div class="step"><div class="step-n">3</div><div class="step-t">Cole o codigo e <strong>confirme o pagamento</strong></div></div>
    <div class="step"><div class="step-n">4</div><div class="step-t"><strong>Acesso liberado automaticamente</strong> em segundos</div></div>
  </div>
  <div class="footer">Pagamento processado com seguranca via Pix — Banco Central do Brasil</div>
</div>
<script>
${mediaUrl ? `setTimeout(()=>{document.getElementById('modelWrap').classList.add('visible');},3000);` : ''}
${!expired ? `
const TOTAL=3*60;let s=TOTAL;
const timerEl=document.getElementById('timer');
const barEl=document.getElementById('cdBar');
const tick=setInterval(()=>{
  s--;
  if(s<=0){clearInterval(tick);timerEl.textContent='00:00';timerEl.classList.add('urgent');barEl.style.width='0%';barEl.classList.add('urgent');
    const btn=document.getElementById('btnPix');btn.disabled=true;btn.textContent='Link expirado';btn.style.background='#d1d5db';btn.style.boxShadow='none';btn.style.cursor='default';return;}
  timerEl.textContent=String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  barEl.style.width=(s/TOTAL*100)+'%';
  if(s<=60){timerEl.classList.add('urgent');barEl.classList.add('urgent');}
},1000);
function copyPix(){
  const code=${JSON.stringify(page.pix_code)};
  const btn=document.getElementById('btnPix');
  const done=()=>{btn.textContent='PIX copiado. Abra seu banco agora';btn.classList.add('ok');setTimeout(()=>{btn.textContent='CLIQUE AQUI PARA COPIAR O PIX';btn.classList.remove('ok');},4000);};
  if(navigator.clipboard)navigator.clipboard.writeText(code).then(done).catch(()=>fb(code,done));else fb(code,done);
}
function fb(t,cb){const el=document.createElement('textarea');el.value=t;el.style.cssText='position:fixed;opacity:0';document.body.appendChild(el);el.select();try{document.execCommand('copy');cb();}catch(e){}document.body.removeChild(el);}
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
        active_instances: getActiveInstances().length,
        total_instances: db.getInstances().filter(i => !i.is_notification).length,
        test_mode: isTestModeActive(),
        funnel_breakdown: funnelBreakdown,
        recovery_stats: recoveryStats,
        start_trigger_stats: startTriggerStats
    }});
});

app.get('/api/conversations', authMiddleware, (req, res) => {
    const list = [...conversations.entries()].map(([phoneKey, conv]) => ({
        id: phoneKey, phone: (conv.remoteJid || '').replace('@s.whatsapp.net', ''), phoneKey,
        customerName: conv.customerName, productId: conv.productId, productName: conv.productName,
        orderBumps: conv.orderBumps || [], funnelId: conv.funnelId, stepIndex: conv.stepIndex,
        amount: conv.amount, amountDisplay: conv.amountDisplay, netValue: conv.netValue,
        pixCode: conv.pixCode, paymentMethod: conv.paymentMethod,
        city: conv.city, state: conv.state, ddd: conv.ddd,
        waiting_for_response: conv.waiting_for_response, pixWaiting: conv.pixWaiting || false,
        createdAt: conv.createdAt, lastMessageAt: conv.lastSystemMessage, lastReplyAt: conv.lastReply,
        orderCode: conv.orderCode, stickyInstance: stickyInstances.get(phoneKey),
        canceled: conv.canceled || false, completed: conv.completed || false,
        hasError: conv.hasError || false, paused: conv.paused || false,
        invalidNumber: conv.invalidNumber || false, reactivation: conv.reactivation || false,
        abFunnelVariant: conv.abFunnelVariant,
        pixTimeoutRemaining: pixTimeouts.has(phoneKey) ? Math.max(0, Math.round((getPixTimeoutMs() - (Date.now() - new Date(pixTimeouts.get(phoneKey).createdAt).getTime())) / 1000)) : null
    })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, data: list });
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
            const hasSticky = !!stickyInstances.get(phoneKey);
            const isStuck = (conv.waiting_for_response || conv.hasError || conv.awaitingPool) && !hasSticky;
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
        stickyInstances.delete(phoneKey);
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
        stickyInstances.clear();
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
        // Zera auto_revenue do dia (pra recontagem)
        db.getDb().prepare(`UPDATE daily_investment SET auto_revenue = 0 WHERE date = ?`).run(date);

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
    db.saveProduct(p); refreshInstanceCache();
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
// Útil pra debugar quando Danilo cadastra trigger e ele não funciona em produção.
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

app.get('/api/instances', authMiddleware, (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    res.json({ success: true, data: db.getInstances(), stats: db.getInstanceStats(days) });
});

// ⭐ DIAGNÓSTICO 04/05: testa a Evolution diretamente — connection state + envio teste — e retorna a resposta crua.
// Use quando ver SEND_FAILED em massa: revela se é problema de auth, instância, formato, timeout, etc.
app.post('/api/diag-evolution', authMiddleware, async (req, res) => {
    try {
        const testPhone = String(req.body?.phone || '').replace(/\D/g, '');
        const instances = db.getInstances().filter(i => !i.paused && i.name && !i.is_notification);
        const results = [];
        for (const inst of instances) {
            const result = { instance: inst.name, phone_number: inst.phone_number };
            // 1) connectionState
            try {
                const r = await axios.get(`${EVOLUTION_BASE_URL}/instance/connectionState/${inst.name}`, { headers: { 'apikey': EVOLUTION_API_KEY }, timeout: 10000 });
                result.connection = { http: r.status, data: r.data };
            } catch(e) {
                result.connection = { http: e.response?.status || e.code, error: e.response?.data || e.message };
            }
            // 2) envio teste (só se phone fornecido)
            if (testPhone && testPhone.length >= 10) {
                try {
                    const r = await axios.post(`${EVOLUTION_BASE_URL}/message/sendText/${inst.name}`,
                        { number: testPhone, text: `[diag] teste de envio ${new Date().toISOString()}` },
                        { headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_API_KEY }, timeout: 15000 });
                    result.send = { http: r.status, data: r.data };
                } catch(e) {
                    result.send = { http: e.response?.status || e.code, error: e.response?.data || e.message };
                }
            }
            results.push(result);
        }
        res.json({ success: true, evolutionUrl: EVOLUTION_BASE_URL, hasApiKey: !!EVOLUTION_API_KEY, testedPhone: testPhone || null, results });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// ⭐ v1.3 — Endpoint de diagnóstico do balanceamento
app.get('/api/load-balance', authMiddleware, (req, res) => {
    const active = getActiveInstances();
    const scores = computeInstanceScores(active);
    scores.sort((a, b) => a.score - b.score);

    // Conta conversas em estado especial
    let waitingSticky = 0;
    let totalSticky = 0;
    const stickyDist = {};
    for (const [phoneKey, instName] of stickyInstances.entries()) {
        if (!instName) continue;
        const conv = conversations.get(phoneKey);
        if (conv && !conv.canceled) {
            totalSticky++;
            stickyDist[instName] = (stickyDist[instName] || 0) + 1;
            if (conv.waitingForStickyReturn) waitingSticky++;
        }
    }

    res.json({
        success: true,
        active_instances: active,
        instance_count: active.length,
        scores,                            // Score de carga (menor = mais ociosa)
        sticky_distribution: stickyDist,   // Quantos clientes cada instância tem como sticky
        total_active_stickys: totalSticky,
        waiting_sticky_return: waitingSticky,  // Quantos aguardando instância voltar
        grace_period_days: parseInt(process.env.GRACE_PERIOD_DAYS || '3')
    });
});

app.post('/api/instances/:name/pause', authMiddleware, (req, res) => {
    db.ensureInstance(req.params.name); db.setInstancePaused(req.params.name, req.body.paused);
    refreshInstanceCache(); addLog('INST_PAUSE', `${req.body.paused ? '⏸️' : '▶️'} ${req.params.name}`);
    res.json({ success: true });
});
app.post('/api/instances/:name/abandono', authMiddleware, (req, res) => {
    const name = req.params.name;
    // Não permite marcar instância de notificação como abandono
    if (name === NOTIFICATION_INSTANCE || name === 'NOTIFICACAO' || name === 'NOTIFICACOES') {
        return res.status(400).json({ success: false, error: 'Instância de notificação não pode ser de abandono' });
    }
    db.setInstanceAbandono(name, !!req.body.is_abandono);
    refreshInstanceCache();
    addLog('INST_ABANDONO', `${req.body.is_abandono ? '🛒' : '📱'} ${name} — ${req.body.is_abandono ? 'agora é de abandono' : 'voltou ao pool principal'}`);
    res.json({ success: true });
});

// ⭐ FIX 05/05: bloquear instância de receber mensagens de carrinho abandonado (proteção do número principal)
app.post('/api/instances/:name/block-abandono', authMiddleware, (req, res) => {
    const name = req.params.name;
    try {
        db.getDb().prepare('UPDATE instances SET block_abandono = ? WHERE name = ?').run(req.body.block_abandono ? 1 : 0, name);
        refreshInstanceCache();
        addLog('INST_BLOCK_ABANDONO', `${req.body.block_abandono ? '🛡️' : '🛒'} ${name} — ${req.body.block_abandono ? 'NÃO recebe mais carrinho abandonado' : 'voltou a receber carrinho abandonado'}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
// Identificação física do chip/celular (pra saber qual aparelho pegar quando instância cair)
// ENDPOINT ANTIGO — mantido por compatibilidade, mas agora também grava no sistema novo por número
app.post('/api/instances/:name/identity', authMiddleware, (req, res) => {
    try {
        const { phone_number, device_name, device_slot, account_type } = req.body || {};
        // Mantém campos na tabela instances (legado)
        db.updateInstanceIdentity(req.params.name, { phone_number, device_name, device_slot, account_type });
        // Se veio número, grava também no sistema novo (fonte da verdade)
        if (phone_number && String(phone_number).trim()) {
            const cleanPhone = String(phone_number).replace(/\D/g, '');
            if (cleanPhone) {
                db.upsertPhoneNumber(cleanPhone, { instance: req.params.name, device_name, device_slot, account_type });
            }
        }
        addLog('INST_IDENTITY', `📝 ${req.params.name} identificado: ${device_name || '?'} · ${phone_number || '?'} · ${account_type || '?'}`);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== SAÚDE POR NÚMERO (nova API) =====
// Lista todos os números conhecidos com sua saúde
app.get('/api/phones', authMiddleware, (req, res) => {
    try {
        const phones = db.getAllPhoneNumbers();
        const summary = db.getPhoneSummary();
        res.json({ success: true, data: phones, summary });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Detalhe completo de um número: identidade + histórico de quedas + mensagens por dia
app.get('/api/phones/:number', authMiddleware, (req, res) => {
    try {
        const phone = db.getPhoneNumber(req.params.number);
        if (!phone) return res.status(404).json({ success: false, error: 'Número não encontrado' });
        const drops = db.getPhoneDrops(req.params.number, 50);
        const messages = db.getPhoneMessageStats(req.params.number, 30);
        res.json({ success: true, data: phone, drops, messages });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Atualiza identidade de um número (celular físico, tipo, notas)
app.post('/api/phones/:number/identity', authMiddleware, (req, res) => {
    try {
        const { device_name, device_slot, account_type, notes, status } = req.body || {};
        // Garante que o número existe (cria se não existir)
        db.upsertPhoneNumber(req.params.number, {});
        db.updatePhoneIdentity(req.params.number, { device_name, device_slot, account_type, notes, status });
        addLog('PHONE_IDENTITY', `📝 Número ${req.params.number}: ${device_name || '?'} · ${account_type || '?'}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Reclassifica uma queda (usuário marca como "era só desconexão técnica" ou "ban real")
app.post('/api/phones/drops/:id/reclassify', authMiddleware, (req, res) => {
    try {
        const { drop_type } = req.body || {};
        if (!['BAN','DISCONNECT','UNKNOWN'].includes(drop_type)) {
            return res.status(400).json({ success: false, error: 'Tipo inválido. Use BAN, DISCONNECT ou UNKNOWN' });
        }
        const ok = db.reclassifyDrop(parseInt(req.params.id), drop_type);
        if (!ok) return res.status(404).json({ success: false, error: 'Queda não encontrada' });
        addLog('DROP_RECLASSIFIED', `🔄 Queda #${req.params.id} reclassificada como ${drop_type}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Força resincronização do número conectado em cada instância (útil pra pegar novos números)
app.post('/api/phones/sync', authMiddleware, async (req, res) => {
    try {
        const instances = db.getInstances().filter(i => !i.paused && i.name);
        let synced = 0;
        for (const inst of instances) {
            const connected = await checkInstanceConnected(inst.name);
            if (!connected) continue;
            const phone = await fetchInstanceOwnerNumber(inst.name);
            if (phone) {
                db.upsertPhoneNumber(phone, { instance: inst.name });
                synced++;
            }
        }
        res.json({ success: true, synced });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/instances/:name', authMiddleware, (req, res) => {
    const name = req.params.name;
    // Não permite deletar a instância de notificação
    if (name === NOTIFICATION_INSTANCE || name === 'NOTIFICACAO' || name === 'NOTIFICACOES') {
        return res.status(400).json({ success: false, error: 'Não é possível remover instância de notificação' });
    }
    try {
        db.getDb().prepare('DELETE FROM instances WHERE name = ?').run(name);
        db.getDb().prepare('DELETE FROM instance_daily_stats WHERE instance = ?').run(name);
        // Remove sticky dessa instância
        for (const [k, v] of stickyInstances.entries()) {
            if (v === name) stickyInstances.delete(k);
        }
        refreshInstanceCache();
        addLog('INST_DELETE', `🗑️ Instância removida: ${name}`);
        res.json({ success: true });
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
        //              Danilo muda no painel pra 5min quando quiser (300000).
        PIX_TIMEOUT_MS: process.env.PIX_TIMEOUT_MS || '420000',
        REACTIVATION_DAYS: process.env.REACTIVATION_DAYS || '3',
        CLEANUP_DAYS: CLEANUP_DAYS.toString(),
        HIGH_TICKET_MIN: '50',
        TAX_RATE: '0.1215',
        MAX_FUNNELS_PER_LEAD_PER_DAY: '3',
        FUNNEL_COOLDOWN_DAYS: '7',
        TEST_MODE: '0',
        // ⭐ FIX 10/05: link de fallback editável pelo admin pra quando o link do cliente falhar
        PIX_FALLBACK_URL: 'https://e-volutionn.com/planosk/',
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

// Detalhe da instância pro drill-down do app: stats hoje, histórico de quedas 7d, flags atuais.
app.get('/api/instances/:name/detail', authMiddleware, (req, res) => {
    try {
        const name = req.params.name;
        const inst = db.getInstances().find(i => i.name === name);
        if (!inst) return res.status(404).json({ success: false, error: 'Instância não encontrada' });

        const stats7d = db.getInstanceStats(7).filter(s => s.instance === name);
        const today = new Date().toISOString().split('T')[0];
        const todayStats = stats7d.find(s => s.date === today) || { messages_sent: 0, leads_attended: 0, conversions: 0 };
        const avg7d = stats7d.length ? stats7d.reduce((a, s) => a + (s.messages_sent || 0), 0) / stats7d.length : 0;

        let phoneInfo = null;
        try { phoneInfo = db.getPhoneNumberByInstance(name); } catch(e) {}
        let drops = [];
        try { drops = phoneInfo?.phone_number ? db.getPhoneDrops(phoneInfo.phone_number, 30) : []; } catch(e) {}
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const drops7dCount = drops.filter(d => new Date(d.dropped_at).getTime() > sevenDaysAgo).length;

        res.json({
            success: true,
            instance: {
                name: inst.name,
                connected: !!inst.connected,
                paused: !!inst.paused,
                is_notification: !!inst.is_notification,
                is_abandono: !!inst.is_abandono,
                block_abandono: !!inst.block_abandono,
                phone_number: phoneInfo?.phone_number || inst.phone_number || null,
                device_name: phoneInfo?.device_name || inst.device_name || null,
                device_slot: phoneInfo?.device_slot || inst.device_slot || null,
                last_connected: inst.last_connected,
                last_disconnected: inst.last_disconnected
            },
            today: {
                messages_sent: todayStats.messages_sent || 0,
                leads_attended: todayStats.leads_attended || 0,
                conversions: todayStats.conversions || 0
            },
            avg7d_messages: Math.round(avg7d),
            drops7d: drops7dCount,
            drops_recent: drops.slice(0, 5).map(d => ({
                at: d.dropped_at,
                type: d.drop_type,
                recovered_at: d.recovered_at
            })),
            stats7d
        });
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
        let aggGross = 0, aggNet = 0, aggSpend = 0, aggTax = 0, aggProfit = 0, aggPaid = 0, aggPixGen = 0;
        for (const dateStr of dates) {
            const finance = db.getFinanceDay(dateStr);
            const netRev = parseFloat(finance.net) || 0;
            const fbSpend = parseFloat(finance.facebook_spend) || 0;
            const taxRate = parseFloat(finance.tax_rate) || 0.1215;
            const taxAmount = netRev * taxRate;
            const netProfit = netRev - fbSpend - taxAmount;
            const roi = fbSpend > 0 ? (netRev / fbSpend) : 0;
            const row = {
                date: dateStr,
                paid: finance.paid || 0,
                pix_paid: finance.pix_paid || 0,
                card_paid: finance.card_paid || 0,
                pix_generated: finance.pix_generated || 0,
                gross_revenue: parseFloat(finance.gross) || 0,
                net_revenue: netRev,
                facebook_spend: fbSpend,
                tax_amount: taxAmount,
                net_profit: netProfit,
                roi: parseFloat(roi.toFixed(2)),
                has_spend_data: fbSpend > 0
            };
            aggGross += row.gross_revenue;
            aggNet += netRev;
            aggSpend += fbSpend;
            aggTax += taxAmount;
            aggProfit += netProfit;
            aggPaid += row.paid;
            aggPixGen += row.pix_generated;
            result.push(row);
        }
        const aggRoi = aggSpend > 0 ? parseFloat((aggNet / aggSpend).toFixed(2)) : 0;
        res.json({
            success: true,
            data: result,
            totals: {
                days: dates.length,
                paid: aggPaid,
                pix_generated: aggPixGen,
                gross_revenue: aggGross,
                net_revenue: aggNet,
                facebook_spend: aggSpend,
                tax_amount: aggTax,
                net_profit: aggProfit,
                roi: aggRoi
            }
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== ADICIONAR GASTO FACEBOOK PELO APP MOBILE =====
// POST /api/investment-add-spend { amount: number, date?: 'YYYY-MM-DD' }
// ADICIONA (não substitui) ao facebook_spend do dia. Idempotência fica por conta do operador.
app.post('/api/investment-add-spend', authMiddleware, (req, res) => {
    try {
        const amount = parseFloat(req.body?.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
            return res.status(400).json({ success: false, error: 'amount inválido (precisa ser número entre 0.01 e 100000)' });
        }
        const date = req.body?.date || todayBR();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ success: false, error: 'date precisa ser YYYY-MM-DD' });
        }
        const existing = db.getDb().prepare('SELECT * FROM daily_investment WHERE date = ?').get(date) || {};
        const previous = parseFloat(existing.facebook_spend) || 0;
        const newSpend = previous + amount;
        const todayEvents = db.getDb().prepare("SELECT SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as rev FROM events WHERE date(datetime(created_at, '-3 hours')) = ?").get(date);
        const autoRev = todayEvents?.rev || existing.auto_revenue || 0;
        const result = db.saveDailyInvestment({
            date,
            facebook_spend: newSpend,
            extra_revenue: existing.extra_revenue || 0,
            auto_revenue: autoRev,
            tax_rate: existing.tax_rate || 0.1215,
            notes: existing.notes ? (existing.notes + ` · +R$${amount.toFixed(2)} via app`) : `+R$${amount.toFixed(2)} via app`
        });
        addLog('INVESTMENT_ADD', `📈 Gasto FB +R$${amount.toFixed(2)} (total ${newSpend.toFixed(2)}) via app mobile`, { date });
        res.json({ success: true, date, added: amount, previous, total: newSpend, data: result });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== ROI AO VIVO (otimizado pra app mobile) =====
// Retorna ROI, lucro, gasto e receita do dia atual num único call.
// Chamado a cada 20s pelo mobile junto do dashboard.
app.get('/api/roi-live', authMiddleware, (req, res) => {
    try {
        const today = todayBR();
        const finance = db.getFinanceDay(today);
        const netRevenue = parseFloat(finance.net) || 0;
        const grossRevenue = parseFloat(finance.gross) || 0;
        const fbSpend = parseFloat(finance.facebook_spend) || 0;
        const taxRate = parseFloat(finance.tax_rate) || 0.1215;
        const taxAmount = netRevenue * taxRate;
        const netProfit = netRevenue - fbSpend - taxAmount;
        // ROI = receita líquida / gasto Facebook (não considera taxa — métrica de tráfego puro)
        const roi = fbSpend > 0 ? (netRevenue / fbSpend) : 0;
        // ROI líquido = lucro / gasto (considera taxa do gateway)
        const roiNet = fbSpend > 0 ? (netProfit / fbSpend) : 0;
        res.json({
            success: true,
            data: {
                date: today,
                paid: finance.paid || 0,
                pix_paid: finance.pix_paid || 0,
                card_paid: finance.card_paid || 0,
                gross_revenue: grossRevenue,
                net_revenue: netRevenue,
                facebook_spend: fbSpend,
                tax_rate: taxRate,
                tax_amount: taxAmount,
                net_profit: netProfit,
                roi: parseFloat(roi.toFixed(2)),
                roi_net: parseFloat(roiNet.toFixed(2)),
                has_spend_data: fbSpend > 0
            }
        });
    } catch(e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ===== DAILY INVESTMENT API =====
app.get('/api/investment', authMiddleware, (req, res) => {
    const { from, to } = req.query;
    const startDate = from || new Date(Date.now() - 30*86400000).toISOString().split('T')[0];
    const endDate = to || new Date().toISOString().split('T')[0];
    const data = db.getDailyInvestmentRange(startDate, endDate);
    // Preenche dias sem dados com zeros
    const result = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
        const dateStr = current.toISOString().split('T')[0];
        const existing = data.find(d => d.date === dateStr);
        // Pega receita automática do dia nos eventos
        const todayEvents = db.getDb().prepare("SELECT SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as rev FROM events WHERE date(created_at) = ?").get(dateStr);
        const autoRev = todayEvents?.rev || existing?.auto_revenue || 0;
        result.push(existing ? { ...existing, auto_revenue: autoRev } : { date: dateStr, facebook_spend: 0, extra_revenue: 0, auto_revenue: autoRev, tax_rate: 0.1215, tax_amount: 0, total_cost: 0, total_revenue: autoRev, net_profit: autoRev, roi: 0, notes: '' });
        current.setDate(current.getDate() + 1);
    }
    res.json({ success: true, data: result });
});
app.post('/api/investment/:date', authMiddleware, (req, res) => {
    const { date } = req.params;
    const { facebook_spend, extra_revenue, notes, tax_rate } = req.body;
    // Pega receita automática do dia
    const todayEvents = db.getDb().prepare("SELECT SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as rev FROM events WHERE date(created_at) = ?").get(date);
    const autoRev = todayEvents?.rev || 0;
    const result = db.saveDailyInvestment({ date, facebook_spend: parseFloat(facebook_spend)||0, extra_revenue: parseFloat(extra_revenue)||0, auto_revenue: autoRev, tax_rate: parseFloat(tax_rate)||0.1215, notes });
    res.json({ success: true, data: result });
});

// ===== INSTANCE HEALTH API =====
app.get('/api/instances/health', authMiddleware, (req, res) => {
    res.json({ success: true, data: db.getInstanceHealth() });
});

// ===== PHONE VARIATIONS API =====
app.get('/api/phone-variations', authMiddleware, (req, res) => {
    const rows = db.getDb().prepare('SELECT * FROM phone_variation_log ORDER BY id DESC LIMIT 100').all();
    res.json({ success: true, data: rows });
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
    try {
        const notif = buildPaymentNotification(type, customerName, netValue);
        await sendPushNotification(notif.title, notif.body, notif.pushType, { isFemale: notif.isFemale, highValue: notif.highValue });
        res.json({ success: true, preview: notif });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// Preferências de notificação — toggles do app (cada tipo pode ser ligado/desligado)
const NOTIF_PREF_LIST = [
    { key: 'notif_pix_generated', label: 'PIX gerado' },
    { key: 'notif_payment', label: 'Pagamento aprovado' },
    { key: 'notif_cart_abandoned', label: 'Carrinho abandonado' },
    { key: 'notif_card_refused', label: 'Cartão recusado' },
    { key: 'notif_morning_summary', label: 'Resumo da manhã (9h)' },
    { key: 'notif_daily_summary', label: 'Fechamento do dia (23:59)' }
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
app.post('/api/finance/day', authMiddleware, (req, res) => {
    try {
        const date = req.body?.date || todayBR();
        const facebook_spend = parseFloat(req.body?.facebook_spend) || 0;
        const tax_rate = parseFloat(req.body?.tax_rate);
        const notes = req.body?.notes || '';
        const auto_revenue = db.getFinanceDay(date).net || 0;
        const result = db.saveDailyInvestment({ date, facebook_spend, tax_rate: isNaN(tax_rate) ? 0.1215 : tax_rate, auto_revenue, notes });
        res.json({ success: true, data: { date, ...result } });
    } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});
app.get('/api/finance/month', authMiddleware, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    const month = req.query.month || (new Date().getMonth() + 1);
    const days = db.getFinanceMonth(year, month);
    const investments = db.getDailyInvestmentByMonth(year, month);
    const invByDate = {};
    for (const inv of investments) invByDate[inv.date] = inv;
    res.json({ success: true, year, month, days, investments: invByDate });
});
app.get('/api/finance/year', authMiddleware, (req, res) => {
    const year = req.query.year || new Date().getFullYear();
    res.json({ success: true, year, months: db.getFinanceYear(year) });
});
app.get('/api/finance/campaigns', authMiddleware, (req, res) => {
    const start = req.query.start || todayBR();
    const end = req.query.end || todayBR();
    res.json({ success: true, data: db.getCampaignROI(start, end) });
});

// ============ META ADS — TRÁFEGO PAGO ============
// Cache simples em memória (TTL 2min) pra não bater na Meta a cada refresh
const metaCache = new Map();
const META_CACHE_TTL = 2 * 60 * 1000;

// ⭐ 15/05: MULTI-BM SUPPORT
// Lê dinamicamente META_ACCESS_TOKEN (BM1, sem sufixo) + META_ACCESS_TOKEN_BM2/BM3/... (até BM20).
// Cada BM tem seu próprio System User token (permanente, não expira). Isolamento de falha: 1 BM cai, outras seguem.
// Uso é 100% leitura (gasto diário por conta) — operador confere manual no FB.

// Filtra token de qualquer mensagem antes de logar/serializar
function _sanitizeMetaError(msg) {
    if (msg == null) return msg;
    return String(msg)
        .replace(/access_token=[^&\s"']+/gi, 'access_token=REDACTED')
        .replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer REDACTED');
}

function _normalizeAccountId(id) {
    return String(id || '').trim().replace(/^act_/i, '').trim();
}

function _parseAccountsString(str) {
    if (!str) return [];
    return str.split(',').map(s => {
        const parts = s.trim().split(':');
        const id = _normalizeAccountId(parts[0]);
        const label = (parts.slice(1).join(':') || id).trim();
        return { id, label };
    }).filter(a => a.id && /^\d+$/.test(a.id));
}

// State global construído no boot — populado por initMetaBMs() + atualizado por checkAllBMsHealth()
let _metaBMs = []; // [{name, token, accounts: [{id, label}], status: 'ok'|'invalid'|'unchecked', healthError, healthName}]
let _accountToBM = new Map(); // accountId (sem act_) → {token, bmName, label}

function initMetaBMs() {
    _metaBMs = [];
    _accountToBM.clear();

    // BM1 (legado, sem sufixo) — retrocompat: se só ele existir, comportamento idêntico ao antigo
    const bm1Token = (process.env.META_ACCESS_TOKEN || '').trim();
    const bm1Accounts = (process.env.META_AD_ACCOUNTS || '').trim();
    if (bm1Token && bm1Accounts) {
        _metaBMs.push({ name: 'BM1', token: bm1Token, accounts: _parseAccountsString(bm1Accounts), status: 'unchecked', healthError: null });
    } else if (bm1Token && !bm1Accounts) {
        console.warn('[META] ⚠️ META_ACCESS_TOKEN definido mas META_AD_ACCOUNTS vazio — BM1 ignorada');
    }

    // BM2..BM20 — varre sufixos numerados
    for (let i = 2; i <= 20; i++) {
        const tk = (process.env[`META_ACCESS_TOKEN_BM${i}`] || '').trim();
        const ac = (process.env[`META_AD_ACCOUNTS_BM${i}`] || '').trim();
        if (!tk && !ac) continue;
        if (!tk || !ac) {
            console.warn(`[META] ⚠️ BM${i} mal configurada (${!tk ? 'TOKEN' : 'ACCOUNTS'} vazio) — ignorando`);
            continue;
        }
        _metaBMs.push({ name: `BM${i}`, token: tk, accounts: _parseAccountsString(ac), status: 'unchecked', healthError: null });
    }

    // Sanity check: BM2+ existe mas BM1 vazio = provável typo do operador
    if (_metaBMs.length > 0 && !_metaBMs.find(b => b.name === 'BM1') && (process.env.META_ACCESS_TOKEN_BM2 || process.env.META_ACCESS_TOKEN_BM3)) {
        console.warn('[META] ⚠️ ATENÇÃO: BM2/BM3 detectada(s) mas META_ACCESS_TOKEN (BM1) está VAZIO. Confirma se isso é intencional ou typo no .env.');
    }

    // Detecta typos da convenção (var META_ACCESS_TOKEN_* ou META_AD_ACCOUNTS_* fora do padrão _BM<n>)
    for (const key of Object.keys(process.env)) {
        if (/^META_ACCESS_TOKEN_/.test(key) && !/^META_ACCESS_TOKEN_BM\d+$/.test(key)) {
            console.warn(`[META] ⚠️ Variável "${key}" não casa padrão "_BM<n>" — ignorada. Use META_ACCESS_TOKEN_BM2, _BM3, etc.`);
        }
        if (/^META_AD_ACCOUNTS_/.test(key) && !/^META_AD_ACCOUNTS_BM\d+$/.test(key)) {
            console.warn(`[META] ⚠️ Variável "${key}" não casa padrão "_BM<n>" — ignorada. Use META_AD_ACCOUNTS_BM2, _BM3, etc.`);
        }
    }

    // Constrói mapa accountId → BM. Detecta duplicidade: primeira BM ganha + WARN
    for (const bm of _metaBMs) {
        for (const acc of bm.accounts) {
            if (_accountToBM.has(acc.id)) {
                const existing = _accountToBM.get(acc.id);
                console.warn(`[META] ⚠️ Conta "${acc.id}" duplicada em ${existing.bmName} e ${bm.name} — usando ${existing.bmName}`);
                try { addLog('META_ACCOUNT_DUP', `⚠️ Conta ${acc.id} declarada em ${existing.bmName} e ${bm.name} — usando ${existing.bmName}`); } catch(e) {}
                continue;
            }
            _accountToBM.set(acc.id, { token: bm.token, bmName: bm.name, label: acc.label });
        }
    }

    // Log final do boot (sem token)
    if (_metaBMs.length > 0) {
        const total = _metaBMs.reduce((a, b) => a + b.accounts.length, 0);
        const summary = _metaBMs.map(b => `${b.name} (${b.accounts.length} contas)`).join(' · ');
        console.log(`[META] ${_metaBMs.length} BM(s): ${summary} · ${total} contas no total`);
    } else {
        console.log('[META] Nenhuma BM configurada — aba Tráfego Pago desabilitada');
    }
}

// Valida cada token via /me da Graph API. Async, roda no boot mas não bloqueia.
async function checkAllBMsHealth() {
    if (!_metaBMs.length) return;
    await Promise.allSettled(_metaBMs.map(async (bm) => {
        try {
            const resp = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/me`, {
                headers: { Authorization: `Bearer ${bm.token}` },
                timeout: 10000
            });
            if (resp.data?.id) {
                bm.status = 'ok';
                bm.healthError = null;
                bm.healthName = resp.data.name || resp.data.id;
                console.log(`[META] ${bm.name}: token válido ✓ (${bm.healthName})`);
            } else {
                bm.status = 'invalid';
                bm.healthError = 'resposta /me sem id';
                console.warn(`[META] ${bm.name}: resposta inesperada de /me`);
            }
        } catch(e) {
            bm.status = 'invalid';
            const rawMsg = e.response?.data?.error?.message || e.message || 'erro desconhecido';
            bm.healthError = _sanitizeMetaError(rawMsg);
            console.error(`[META] ${bm.name}: TOKEN INVÁLIDO — ${bm.healthError}`);
            try { addLog('META_TOKEN_INVALID', `❌ ${bm.name}: ${bm.healthError}`); } catch(_) {}
        }
    }));
}

// Retorna { token, bmName, label } pra uma conta. Fallback: BM1 (caso conta não declarada no env).
function getTokenForAccount(accountId) {
    const normalized = _normalizeAccountId(accountId);
    const found = _accountToBM.get(normalized);
    if (found) return found;
    // Fallback transparente — útil quando descobre conta nova via /me/adaccounts
    const bm1 = _metaBMs.find(b => b.name === 'BM1');
    if (bm1) return { token: bm1.token, bmName: 'BM1', label: normalized, fallback: true };
    return null;
}

function parseMetaAccounts() {
    // Retorna union de todas as BMs. Mantém ordem das BMs (BM1 primeiro).
    const out = [];
    for (const bm of _metaBMs) {
        for (const acc of bm.accounts) {
            out.push({ id: acc.id, label: acc.label, bm: bm.name });
        }
    }
    return out;
}

function getMetaBMsStatus() {
    return _metaBMs.map(bm => ({
        name: bm.name,
        status: bm.status,
        ok: bm.status === 'ok',
        error: bm.healthError || null,
        accounts: bm.accounts.length,
        identity: bm.healthName || null
    }));
}

function isMetaConfigured() {
    return _metaBMs.length > 0;
}

// Inicialização do módulo Meta
initMetaBMs();
// Health check async — não bloqueia startup
setTimeout(() => { checkAllBMsHealth().catch(e => console.error('[META] health check erro:', _sanitizeMetaError(e.message))); }, 1000);
// Revalida tokens a cada 30min (BM cai → operador vê ⚠️ no painel)
setInterval(() => { checkAllBMsHealth().catch(() => {}); }, 30 * 60 * 1000);

// ⭐ 15/05: Auto-sync Meta → daily_investment a cada 10min, das 8h-23h BR.
// Atualiza gasto FB do dia atual em background — operador vê gasto fresco no Hero sem tocar em "🔄 Sincronizar".
// Fora do horário comercial (23h-8h) NÃO roda — economiza ~9h de requests/dia.
// Pra desligar: META_AUTO_SYNC_ENABLED=0 no .env.
let _lastMetaAutoSync = null;
let _lastMetaAutoSyncError = null;
let _lastMetaAutoSyncSpend = null;

async function autoSyncMetaToday() {
    if (!isMetaConfigured()) return;
    if (process.env.META_AUTO_SYNC_ENABLED === '0') return;

    // Horário comercial BR: 8h-23h. UTC = BR + 3h.
    const now = new Date();
    const brHour = (now.getUTCHours() - 3 + 24) % 24;
    if (brHour < 8 || brHour >= 23) return;

    try {
        const data = await getMetaInsights('today');
        if (!data.success) {
            _lastMetaAutoSyncError = _sanitizeMetaError(data.error || 'sem detalhe');
            return;
        }

        // dateBR usando o mesmo helper que /api/finance/sync-meta-day
        const brOffset = -3 * 60 * 60 * 1000;
        const dateBR = new Date(now.getTime() + brOffset).toISOString().split('T')[0];

        const totalSpend = data.totals.spend || 0;
        const existing = db.getDb().prepare('SELECT * FROM daily_investment WHERE date = ?').get(dateBR);
        const taxRate = existing?.tax_rate || 0.1215;
        const auto_revenue = db.getFinanceDay(dateBR).net || 0;
        const oldSpend = existing?.facebook_spend || 0;

        db.saveDailyInvestment({
            date: dateBR,
            facebook_spend: totalSpend,
            tax_rate: taxRate,
            auto_revenue,
            notes: existing?.notes || '[auto-sync Meta cron 10min]'
        });

        _lastMetaAutoSync = new Date();
        _lastMetaAutoSyncError = null;
        _lastMetaAutoSyncSpend = totalSpend;

        // Só loga se houve mudança relevante (≥ R$0,50 de diferença)
        if (Math.abs(totalSpend - oldSpend) >= 0.5) {
            const diff = totalSpend - oldSpend;
            const sign = diff > 0 ? '+' : '';
            console.log(`[META auto-sync] ${dateBR}: R$${oldSpend.toFixed(2)} → R$${totalSpend.toFixed(2)} (${sign}R$${diff.toFixed(2)})`);
        }
    } catch(e) {
        _lastMetaAutoSyncError = _sanitizeMetaError(e.message);
        try { addLog('META_AUTO_SYNC_ERR', _sanitizeMetaError(e.message)); } catch(_) {}
    }
}

// Primeira sync 60s depois do boot (dá tempo do health check rodar)
setTimeout(() => { autoSyncMetaToday().catch(() => {}); }, 60000);
// Depois a cada 10min
setInterval(() => { autoSyncMetaToday().catch(() => {}); }, 10 * 60 * 1000);

async function fetchInsightsForAccount(accountId, datePreset, timeRange) {
    const tk = getTokenForAccount(accountId);
    if (!tk) {
        addLog('META_NO_TOKEN', `❌ Sem token pra conta ${accountId}`);
        return [];
    }
    const params = {
        fields: 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc,cpm,actions',
        level: 'campaign',
        limit: 200
    };
    if (timeRange) params.time_range = JSON.stringify(timeRange);
    else params.date_preset = datePreset || 'today';

    try {
        const resp = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/insights`, {
            headers: { Authorization: `Bearer ${tk.token}` },
            params,
            timeout: 15000
        });
        return resp.data.data || [];
    } catch (e) {
        const errMsg = _sanitizeMetaError(e.response?.data?.error?.message || e.message);
        addLog('META_FETCH_ERR', `${tk.bmName}/${accountId}: ${errMsg}`);
        return [];
    }
}

// Busca campanhas ATIVAS (mesmo sem gasto/impressões hoje)
async function fetchActiveCampaignsForAccount(accountId) {
    const tk = getTokenForAccount(accountId);
    if (!tk) return [];
    const filtering = JSON.stringify([{field:'effective_status',operator:'IN',value:['ACTIVE']}]);
    try {
        const resp = await axios.get(`https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/campaigns`, {
            headers: { Authorization: `Bearer ${tk.token}` },
            params: {
                fields: 'id,name,daily_budget,status,effective_status',
                filtering,
                limit: 200
            },
            timeout: 15000
        });
        return resp.data.data || [];
    } catch (e) {
        const errMsg = _sanitizeMetaError(e.response?.data?.error?.message || e.message);
        addLog('META_CAMPAIGNS_ERR', `${tk.bmName}/${accountId}: ${errMsg}`);
        return [];
    }
}

function extractPurchases(actions) {
    if (!Array.isArray(actions)) return 0;
    const a = actions.find(x => x.action_type === 'omni_purchase')
        || actions.find(x => x.action_type === 'purchase')
        || actions.find(x => x.action_type === 'offsite_conversion.fb_pixel_purchase');
    return a ? parseInt(a.value, 10) || 0 : 0;
}

async function getMetaInsights(datePreset, timeRange) {
    const cacheKey = timeRange ? `range:${JSON.stringify(timeRange)}` : `preset:${datePreset || 'today'}`;
    const cached = metaCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < META_CACHE_TTL) {
        return { ...cached.data, cached: true, cache_age_sec: Math.floor((Date.now() - cached.at) / 1000) };
    }

    const accounts = parseMetaAccounts();
    if (accounts.length === 0) {
        return { success: false, error: 'Meta Ads não configurado', accounts: [], totals: {}, campaigns: [], bmsStatus: getMetaBMsStatus() };
    }

    // Busca em paralelo (insights + lista de campanhas ativas).
    // ⭐ 15/05: allSettled — falha de 1 conta não derruba o agregado. fetchInsightsForAccount/Campaigns já tratam erro internamente.
    const settled = await Promise.allSettled(accounts.map(async (acc) => {
        const [insights, activeCamps] = await Promise.all([
            fetchInsightsForAccount(acc.id, datePreset, timeRange),
            fetchActiveCampaignsForAccount(acc.id)
        ]);
        // MERGE: insights tem dados; activeCamps tem todas ativas (mesmo sem gasto)
        const insightsByCampId = {};
        for (const ins of insights) insightsByCampId[ins.campaign_id] = ins;
        const merged = [];
        // Primeiro, adiciona TODAS as campanhas ATIVAS (com ou sem insights)
        for (const ac of activeCamps) {
            const ins = insightsByCampId[ac.id];
            if (ins) {
                merged.push(ins);
                delete insightsByCampId[ac.id];
            } else {
                // Campanha ativa sem gasto/impressões hoje — entra com zeros
                merged.push({
                    campaign_id: ac.id,
                    campaign_name: ac.name,
                    spend: '0', impressions: '0', clicks: '0', ctr: '0', cpc: '0', cpm: '0',
                    actions: []
                });
            }
        }
        // Depois, adiciona insights "órfãos" (de campanhas pausadas/inativas que ainda gastaram hoje)
        for (const id in insightsByCampId) merged.push(insightsByCampId[id]);
        return { account: acc, campaigns: merged };
    }));

    // allSettled: extrai resultados ok, descarta rejected (que já foi logado pelas fetch* funções)
    const results = settled.filter(s => s.status === 'fulfilled').map(s => s.value);

    let totals = { spend: 0, impressions: 0, clicks: 0, purchases: 0, accounts_count: 0, campaigns_count: 0 };
    const allCampaigns = [];

    for (const r of results) {
        let accSpend = 0, accPurch = 0, accClicks = 0, accImpr = 0, accCamps = 0;
        for (const c of r.campaigns) {
            const spend = parseFloat(c.spend || 0);
            const impressions = parseInt(c.impressions || 0, 10);
            const clicks = parseInt(c.clicks || 0, 10);
            const ctr = parseFloat(c.ctr || 0);
            const cpc = parseFloat(c.cpc || 0);
            const cpm = parseFloat(c.cpm || 0);
            const purchases = extractPurchases(c.actions);
            const cpa = purchases > 0 ? +(spend / purchases).toFixed(2) : null;

            // Sugestão automática (régua de pausa baseada no histórico de abril do Danilo)
            let action = 'monitor';
            let actionReason = '';
            if (purchases === 0 && spend >= META_PAUSE_THRESHOLD) {
                action = 'pause';
                actionReason = `R$${spend.toFixed(2)} sem venda — passou do limite de R$${META_PAUSE_THRESHOLD}`;
            } else if (purchases >= 1 && cpa && cpa <= 15) {
                action = 'scale';
                actionReason = `CPA R$${cpa.toFixed(2)} ≤ R$15 — duplicar 3x amanhã`;
            } else if (purchases >= 1 && cpa && cpa > 25) {
                action = 'pause';
                actionReason = `CPA R$${cpa.toFixed(2)} acima da faixa lucrativa (>R$20)`;
            } else if (purchases >= 1 && cpa && cpa <= 20) {
                action = 'keep';
                actionReason = `CPA R$${cpa.toFixed(2)} dentro da faixa boa`;
            } else if (purchases === 0 && spend < META_PAUSE_THRESHOLD) {
                action = 'monitor';
                actionReason = `Aguardando: gastou R$${spend.toFixed(2)} de R$${META_PAUSE_THRESHOLD}`;
            }

            allCampaigns.push({
                account_id: r.account.id,
                account_label: r.account.label,
                campaign_id: c.campaign_id,
                campaign_name: c.campaign_name,
                spend, impressions, clicks, ctr, cpc, cpm, purchases, cpa,
                action, action_reason: actionReason
            });

            accSpend += spend;
            accPurch += purchases;
            accClicks += clicks;
            accImpr += impressions;
            accCamps += 1;
            totals.spend += spend;
            totals.purchases += purchases;
            totals.clicks += clicks;
            totals.impressions += impressions;
            totals.campaigns_count += 1;
        }
        if (accCamps > 0) totals.accounts_count += 1;
        r.account.totals = {
            spend: +accSpend.toFixed(2),
            purchases: accPurch,
            clicks: accClicks,
            impressions: accImpr,
            campaigns: accCamps,
            cpa: accPurch > 0 ? +(accSpend / accPurch).toFixed(2) : null
        };
    }

    totals.cpa = totals.purchases > 0 ? +(totals.spend / totals.purchases).toFixed(2) : null;
    totals.spend = +totals.spend.toFixed(2);

    const bmsStatus = getMetaBMsStatus();
    const data = {
        success: true,
        fetched_at: new Date().toISOString(),
        totals,
        accounts: results.map(r => ({ ...r.account })),
        campaigns: allCampaigns,
        bmsStatus,
        cached: false
    };
    metaCache.set(cacheKey, { at: Date.now(), data });
    return data;
}

// Endpoint de health check rápido pra UI mostrar status sem buscar insights
app.get('/api/meta/health', authMiddleware, (req, res) => {
    res.json({
        success: true,
        configured: isMetaConfigured(),
        bmsStatus: getMetaBMsStatus(),
        total_accounts: parseMetaAccounts().length
    });
});

// Status do auto-sync — pro app mostrar "última atualização há X min" perto do botão de sync manual
app.get('/api/meta/auto-sync-status', authMiddleware, (req, res) => {
    const enabled = isMetaConfigured() && process.env.META_AUTO_SYNC_ENABLED !== '0';
    const now = new Date();
    const brHour = (now.getUTCHours() - 3 + 24) % 24;
    const inHours = brHour >= 8 && brHour < 23;
    res.json({
        success: true,
        enabled,
        in_business_hours: inHours,
        interval_min: 10,
        window: '08:00-23:00 BR',
        last_sync: _lastMetaAutoSync ? _lastMetaAutoSync.toISOString() : null,
        last_sync_age_sec: _lastMetaAutoSync ? Math.floor((Date.now() - _lastMetaAutoSync.getTime()) / 1000) : null,
        last_spend: _lastMetaAutoSyncSpend,
        last_error: _lastMetaAutoSyncError
    });
});

// Endpoint admin: força recheck dos tokens (usar quando trocar BM no .env)
app.post('/api/meta/recheck', authMiddleware, async (req, res) => {
    try {
        await checkAllBMsHealth();
        res.json({ success: true, bmsStatus: getMetaBMsStatus() });
    } catch (e) {
        res.status(500).json({ success: false, error: _sanitizeMetaError(e.message) });
    }
});

// GET /api/meta/insights?period=today|yesterday|last_7d|last_30d
app.get('/api/meta/insights', authMiddleware, async (req, res) => {
    try {
        if (!isMetaConfigured()) return res.json({ success: false, error: 'Meta Ads não configurado' });
        const period = req.query.period || 'today';
        const allowed = ['today', 'yesterday', 'last_3d', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'];
        const datePreset = allowed.includes(period) ? period : 'today';
        const data = await getMetaInsights(datePreset);
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/finance/sync-meta-day — sincroniza gasto Meta com daily_investment de um dia
// Chamado automaticamente quando o painel Tráfego Pago carrega "today" / "yesterday"
app.post('/api/finance/sync-meta-day', authMiddleware, async (req, res) => {
    try {
        if (!isMetaConfigured()) return res.json({ success: false, error: 'Meta Ads não configurado' });
        const period = req.body?.period || 'today';
        if (!['today', 'yesterday'].includes(period)) {
            return res.status(400).json({ success: false, error: 'period precisa ser today ou yesterday' });
        }
        const data = await getMetaInsights(period);
        if (!data.success) return res.json({ success: false, error: data.error });

        // Determina a data BR
        const now = new Date();
        const brOffset = -3 * 60 * 60 * 1000;
        let dateBR;
        if (period === 'today') {
            dateBR = new Date(now.getTime() + brOffset).toISOString().split('T')[0];
        } else {
            dateBR = new Date(now.getTime() + brOffset - 24*60*60*1000).toISOString().split('T')[0];
        }

        const totalSpend = data.totals.spend || 0;
        const existing = db.getDb().prepare('SELECT * FROM daily_investment WHERE date = ?').get(dateBR);
        const taxRate = existing?.tax_rate || 0.1215;
        const auto_revenue = db.getFinanceDay(dateBR).net || 0;
        const result = db.saveDailyInvestment({
            date: dateBR,
            facebook_spend: totalSpend,
            tax_rate: taxRate,
            auto_revenue,
            notes: existing?.notes || '[auto-sync Meta]'
        });
        res.json({ success: true, date: dateBR, facebook_spend: totalSpend, ...result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/finance/sync-meta-range — sincroniza gasto Meta de um range de datas (uso pra histórico mensal)
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } — itera dia a dia, popula daily_investment.
// Rate-limited internamente (300ms entre requests) pra não bater no rate limit da Meta Graph API.
app.post('/api/finance/sync-meta-range', authMiddleware, async (req, res) => {
    try {
        if (!isMetaConfigured()) return res.json({ success: false, error: 'Meta Ads não configurado' });
        const { from, to } = req.body || {};
        if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            return res.status(400).json({ success: false, error: 'from/to no formato YYYY-MM-DD obrigatórios' });
        }
        const start = new Date(from + 'T00:00:00');
        const end = new Date(to + 'T00:00:00');
        if (end < start) return res.status(400).json({ success: false, error: 'to precisa ser ≥ from' });
        const diffDays = Math.floor((end - start) / 86400000) + 1;
        if (diffDays > 92) return res.status(400).json({ success: false, error: 'range máximo 92 dias' });

        const dates = [];
        for (let i = 0; i < diffDays; i++) {
            const d = new Date(start.getTime() + i * 86400000);
            dates.push(d.toISOString().split('T')[0]);
        }

        const results = [];
        let synced = 0, failed = 0;
        for (const dateBR of dates) {
            try {
                const insights = await getMetaInsights(null, { since: dateBR, until: dateBR });
                if (!insights.success) {
                    failed++;
                    results.push({ date: dateBR, ok: false, error: insights.error });
                    continue;
                }
                const totalSpend = insights.totals.spend || 0;
                const existing = db.getDb().prepare('SELECT * FROM daily_investment WHERE date = ?').get(dateBR);
                const taxRate = existing?.tax_rate || 0.1215;
                const auto_revenue = db.getFinanceDay(dateBR).net || 0;
                db.saveDailyInvestment({
                    date: dateBR,
                    facebook_spend: totalSpend,
                    tax_rate: taxRate,
                    auto_revenue,
                    notes: existing?.notes || '[auto-sync Meta range]'
                });
                synced++;
                results.push({ date: dateBR, ok: true, spend: totalSpend });
            } catch (e) {
                failed++;
                results.push({ date: dateBR, ok: false, error: e.message });
            }
            // Rate limit: 300ms entre dias (evita esgotar quota Meta)
            await new Promise(r => setTimeout(r, 300));
        }
        addLog('META_SYNC_RANGE', `📊 Sync Meta range ${from}→${to}: ${synced} OK · ${failed} falhas`);
        res.json({ success: true, synced, failed, days: diffDays, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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


// ============ INICIALIZAÇÃO ============
app.listen(PORT, async () => {
    console.log('='.repeat(60));
    console.log('🌌 ORION v2.0 — Sistema de Automação WhatsApp');
    console.log('='.repeat(60));
    console.log(`✅ Porta: ${PORT} | Evolution: ${EVOLUTION_BASE_URL}`);
    console.log(`✅ Instâncias: ${CONFIGURED_INSTANCES.join(', ')}`);
    console.log('🔔 Notificações: apenas push do app (canal WhatsApp removido)');
    console.log('='.repeat(60));
    console.log('🔧 Funcionalidades v2.0:');
    console.log('  ✅ A/B Test com rotação por instância');
    console.log('  ✅ Gatilhos globais (contém/exato/similar)');
    console.log('  ✅ Blacklist global por gatilho');
    console.log('  ✅ Delay com variação aleatória ±20%');
    console.log('  ✅ Variáveis: {NOME} {SAUDACAO} {CIDADE} {ESTADO}');
    console.log('  ✅ Personalização por horário (manhã/tarde/noite)');
    console.log('  ✅ Reativação de lead antigo');
    console.log('  ✅ Push no app: vendas + resumos 9h e 23:59 (preferências em /api/notification-prefs)');
    console.log('  ✅ Bloqueio automático via gatilho');
    console.log('  ✅ Figurinha como bloco de funil');
    if (process.env.APP_URL) {
        console.log(`  ✅ PIX pages ativas → ${process.env.APP_URL}/pix/:token`);
    }
    if (PIX_DOMAIN) {
        console.log(`  ✅ Isolamento de domínio PIX → ${PIX_DOMAIN}`);
    }
    if (LINKROTATOR_URL && LINKROTATOR_TOKEN) {
        console.log(`  ✅ Relay LinkRotator ativo → ${LINKROTATOR_URL}`);
    } else {
        console.log(`  ⚠️  Relay LinkRotator desativado (configure LINKROTATOR_URL e LINKROTATOR_TOKEN para ativar)`);
    }
    console.log('='.repeat(60));
    await checkInstancesHealth();
    restoreStickyFromDB();
    restorePendingConversations();
    restorePendingPixTimeouts();
    recoverStuckConversations();
    // Sync inicial dos números conectados (em paralelo, sem bloquear boot)
    (async () => {
        try {
            const instances = db.getInstances().filter(i => !i.paused && i.name);
            for (const inst of instances) {
                const connected = await checkInstanceConnected(inst.name);
                if (!connected) continue;
                const phone = await fetchInstanceOwnerNumber(inst.name);
                if (phone) {
                    db.upsertPhoneNumber(phone, { instance: inst.name });
                    console.log(`📞 ${inst.name} → ${phone}`);
                }
            }
        } catch(e) { console.log('Sync inicial números:', e.message); }
    })();
});
// A cada 5 minutos, resincroniza números (detecta troca de chip)
setInterval(async () => {
    try {
        const instances = db.getInstances().filter(i => !i.paused && i.name);
        for (const inst of instances) {
            const connected = await checkInstanceConnected(inst.name);
            if (!connected) continue;
            const phone = await fetchInstanceOwnerNumber(inst.name);
            if (phone) db.upsertPhoneNumber(phone, { instance: inst.name });
        }
    } catch(e) {}
}, 5 * 60 * 1000);
