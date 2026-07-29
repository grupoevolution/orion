const path = require('path');
const fs = require('fs');

let db;

function getDb() {
    if (!db) throw new Error('Banco não inicializado');
    return db;
}

function initDatabase() {
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    db = new Database(path.join(dataDir, 'orion.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            active INTEGER DEFAULT 1,
            ab_funnel_ids TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS product_offers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT NOT NULL,
            offer_id TEXT NOT NULL,
            platform TEXT DEFAULT 'kirvano',
            FOREIGN KEY(product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS funnels (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT NOT NULL,
            steps TEXT DEFAULT '[]',
            ab_enabled INTEGER DEFAULT 0,
            ab_conversions INTEGER DEFAULT 0,
            ab_leads INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS triggers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            keywords TEXT NOT NULL,
            match_type TEXT DEFAULT 'contains',
            target_funnel_id TEXT,
            auto_block INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS blacklist (
            phone_key TEXT PRIMARY KEY,
            phone TEXT,
            reason TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS conversations (
            phone_key TEXT PRIMARY KEY,
            remote_jid TEXT,
            funnel_id TEXT,
            step_index INTEGER DEFAULT 0,
            order_code TEXT,
            customer_name TEXT,
            product_id TEXT,
            product_name TEXT,
            order_bumps TEXT DEFAULT '[]',
            amount REAL DEFAULT 0,
            amount_display TEXT,
            net_value REAL DEFAULT 0,
            pix_code TEXT,
            payment_method TEXT DEFAULT 'PIX',
            ddd TEXT,
            city TEXT,
            state TEXT,
            waiting_for_response INTEGER DEFAULT 0,
            pix_waiting INTEGER DEFAULT 0,
            sticky_instance TEXT,
            canceled INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            has_error INTEGER DEFAULT 0,
            invalid_number INTEGER DEFAULT 0,
            transferred_from_pix INTEGER DEFAULT 0,
            paused INTEGER DEFAULT 0,
            reactivation INTEGER DEFAULT 0,
            ab_funnel_variant TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            last_message_at TEXT,
            last_reply_at TEXT,
            completed_at TEXT,
            canceled_at TEXT
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            phone_key TEXT,
            product_id TEXT,
            product_name TEXT,
            amount REAL,
            net_value REAL,
            payment_method TEXT,
            order_code TEXT,
            order_bumps TEXT DEFAULT '[]',
            instance TEXT,
            funnel_id TEXT,
            extra TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS messages_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_key TEXT NOT NULL,
            direction TEXT NOT NULL,
            content TEXT,
            instance TEXT,
            step_id TEXT,
            delivered INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS instances (
            name TEXT PRIMARY KEY,
            paused INTEGER DEFAULT 0,
            connected INTEGER DEFAULT 1,
            is_notification INTEGER DEFAULT 0,
            messages_total INTEGER DEFAULT 0,
            conversions INTEGER DEFAULT 0,
            last_seen TEXT DEFAULT (datetime('now')),
            last_disconnected TEXT,
            last_connected TEXT DEFAULT (datetime('now')),
            added_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS instance_daily_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance TEXT NOT NULL,
            date TEXT NOT NULL,
            messages_sent INTEGER DEFAULT 0,
            leads_attended INTEGER DEFAULT 0,
            conversions INTEGER DEFAULT 0,
            UNIQUE(instance, date)
        );

        CREATE TABLE IF NOT EXISTS word_frequency (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT NOT NULL,
            product_id TEXT DEFAULT 'ALL',
            count INTEGER DEFAULT 1,
            last_seen TEXT DEFAULT (datetime('now')),
            UNIQUE(word, product_id)
        );

        CREATE TABLE IF NOT EXISTS notification_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            message TEXT,
            sent INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages_log(phone_key);
        CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
        CREATE INDEX IF NOT EXISTS idx_blacklist ON blacklist(phone_key);

        CREATE TABLE IF NOT EXISTS daily_investment (
            date TEXT PRIMARY KEY,
            facebook_spend REAL DEFAULT 0,
            extra_revenue REAL DEFAULT 0,
            auto_revenue REAL DEFAULT 0,
            tax_rate REAL DEFAULT 0.1215,
            tax_amount REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            total_revenue REAL DEFAULT 0,
            net_profit REAL DEFAULT 0,
            roi REAL DEFAULT 0,
            notes TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS phone_variation_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            original_phone TEXT NOT NULL,
            working_variation TEXT,
            failed_variations TEXT DEFAULT '[]',
            success INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS instance_health (
            instance TEXT PRIMARY KEY,
            score INTEGER DEFAULT 100,
            total_sends INTEGER DEFAULT 0,
            failed_sends INTEGER DEFAULT 0,
            invalid_numbers INTEGER DEFAULT 0,
            last_error TEXT,
            last_checked TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS funnel_receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_key TEXT NOT NULL,
            product_id TEXT NOT NULL,
            funnel_type TEXT NOT NULL,
            funnel_id TEXT,
            received_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_funnel_receipts_lookup ON funnel_receipts(phone_key, product_id, funnel_type, received_at);

        CREATE TABLE IF NOT EXISTS pending_pix_timeouts (
            phone_key TEXT PRIMARY KEY,
            order_code TEXT NOT NULL,
            fire_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS phone_numbers (
            phone_number TEXT PRIMARY KEY,
            device_name TEXT,
            device_slot TEXT,
            account_type TEXT,
            current_instance TEXT,
            last_known_instance TEXT,
            total_drops INTEGER DEFAULT 0,
            total_bans INTEGER DEFAULT 0,
            total_disconnects INTEGER DEFAULT 0,
            total_messages_sent INTEGER DEFAULT 0,
            status TEXT DEFAULT 'ACTIVE',
            notes TEXT,
            first_seen_at TEXT DEFAULT (datetime('now')),
            last_seen_at TEXT DEFAULT (datetime('now')),
            last_drop_at TEXT,
            last_recovery_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_phone_numbers_device ON phone_numbers(device_name);
        CREATE INDEX IF NOT EXISTS idx_phone_numbers_instance ON phone_numbers(current_instance);

        CREATE TABLE IF NOT EXISTS phone_drops (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_number TEXT NOT NULL,
            instance_name TEXT,
            drop_type TEXT DEFAULT 'UNKNOWN',
            dropped_at TEXT DEFAULT (datetime('now')),
            recovered_at TEXT,
            duration_seconds INTEGER,
            notes TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_phone_drops_number ON phone_drops(phone_number, dropped_at);

        CREATE TABLE IF NOT EXISTS phone_messages_daily (
            phone_number TEXT NOT NULL,
            date TEXT NOT NULL,
            messages_sent INTEGER DEFAULT 0,
            PRIMARY KEY (phone_number, date)
        );

        CREATE TABLE IF NOT EXISTS start_triggers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            keywords TEXT NOT NULL,
            match_type TEXT DEFAULT 'contains',
            target_funnel_id TEXT NOT NULL,
            target_product_id TEXT,
            instances TEXT DEFAULT '[]',
            active INTEGER DEFAULT 1,
            triggered_count INTEGER DEFAULT 0,
            last_triggered_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_start_triggers_active ON start_triggers(active);
    `);

    // Produto padrão
    const existing = db.prepare('SELECT id FROM products WHERE id = ?').get('GRUPO_VIP');
    if (!existing) {
        db.prepare('INSERT INTO products (id, name, active, ab_funnel_ids) VALUES (?, ?, 1, ?)').run('GRUPO_VIP', 'GRUPO VIP', '[]');
        db.prepare('INSERT OR IGNORE INTO product_offers (product_id, offer_id, platform) VALUES (?, ?, ?)').run('GRUPO_VIP', 'e79419d3-5b71-4f90-954b-b05e94de8d98', 'kirvano');
        db.prepare('INSERT OR IGNORE INTO product_offers (product_id, offer_id, platform) VALUES (?, ?, ?)').run('GRUPO_VIP', '06539c76-40ee-4811-8351-ab3f5ccc4437', 'kirvano');
        db.prepare('INSERT OR IGNORE INTO product_offers (product_id, offer_id, platform) VALUES (?, ?, ?)').run('GRUPO_VIP', '564bb9bb-718a-4e8b-a843-a2da62f616f0', 'kirvano');
        db.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run('GRUPO_VIP_PIX', 'GRUPO_VIP', 'PIX', 'GRUPO VIP - PIX Pendente', '[]');
        db.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run('GRUPO_VIP_APROVADA', 'GRUPO_VIP', 'APROVADA', 'GRUPO VIP - Compra Aprovada', '[]');
        db.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run('GRUPO_VIP_ABANDONO', 'GRUPO_VIP', 'ABANDONO', 'GRUPO VIP - Carrinho Abandonado', '[]');
        db.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run('GRUPO_VIP_CARTAO_RECUSADO', 'GRUPO_VIP', 'CARTAO_RECUSADO', 'GRUPO VIP - Cartão Recusado', '[]');
        // ⭐ 29/07: "produto" GLOBAL — funis criados nele valem pra TODOS os produtos (era da API oficial)
        db.prepare("INSERT OR IGNORE INTO products (id, name, active) VALUES ('GLOBAL', '🌐 GLOBAL — vale pra todos os produtos', 1)").run();
    }

    // ===== MIGRAÇÕES AUTOMÁTICAS =====
    const migrations = [
        "ALTER TABLE instances ADD COLUMN is_notification INTEGER DEFAULT 0",
        "ALTER TABLE instances ADD COLUMN conversions INTEGER DEFAULT 0",
        "ALTER TABLE products ADD COLUMN ab_funnel_ids TEXT DEFAULT '[]'",
        "ALTER TABLE conversations ADD COLUMN amount REAL DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN amount_display TEXT",
        "ALTER TABLE conversations ADD COLUMN net_value REAL DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN ddd TEXT",
        "ALTER TABLE conversations ADD COLUMN city TEXT",
        "ALTER TABLE conversations ADD COLUMN state TEXT",
        "ALTER TABLE conversations ADD COLUMN invalid_number INTEGER DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN reactivation INTEGER DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN ab_funnel_variant TEXT",
        "ALTER TABLE conversations ADD COLUMN cancel_reason TEXT",
        "ALTER TABLE instance_daily_stats ADD COLUMN conversions INTEGER DEFAULT 0",
        "ALTER TABLE funnels ADD COLUMN ab_enabled INTEGER DEFAULT 0",
        "ALTER TABLE funnels ADD COLUMN ab_conversions INTEGER DEFAULT 0",
        "ALTER TABLE funnels ADD COLUMN ab_leads INTEGER DEFAULT 0",
        "ALTER TABLE events ADD COLUMN net_value REAL DEFAULT 0",
        "ALTER TABLE events ADD COLUMN funnel_id TEXT",
        "ALTER TABLE messages_log ADD COLUMN delivered INTEGER DEFAULT 1",
        "ALTER TABLE messages_log ADD COLUMN step_id TEXT",
        "ALTER TABLE instances ADD COLUMN is_abandono INTEGER DEFAULT 0",
        "ALTER TABLE instances ADD COLUMN phone_number TEXT",
        "ALTER TABLE instances ADD COLUMN device_name TEXT",
        "ALTER TABLE instances ADD COLUMN device_slot TEXT",
        "ALTER TABLE instances ADD COLUMN account_type TEXT",
        "ALTER TABLE funnels ADD COLUMN enabled INTEGER DEFAULT 1",
        "ALTER TABLE conversations ADD COLUMN checkout_url TEXT",
        "ALTER TABLE products ADD COLUMN pix_page_title TEXT",
        "ALTER TABLE products ADD COLUMN pix_page_model_name TEXT",
        "ALTER TABLE products ADD COLUMN pix_page_overlay_text TEXT",
        "ALTER TABLE products ADD COLUMN pix_page_media_url TEXT",
        "ALTER TABLE pix_pages ADD COLUMN products_json TEXT",
        // ⭐ FIX 04/05: persistir flags que viviam só em memória (perdiam no deploy/restart)
        "ALTER TABLE conversations ADD COLUMN awaiting_pool INTEGER DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN waiting_for_sticky_return INTEGER DEFAULT 0",
        "ALTER TABLE conversations ADD COLUMN funnel_type TEXT",
        "ALTER TABLE conversations ADD COLUMN last_send_error TEXT",
        // ⭐ FIX 05/05: flag pra "PROTEGER" essa instância de carrinho abandonado
        "ALTER TABLE instances ADD COLUMN block_abandono INTEGER DEFAULT 0",
        // ⭐ 20/07: e-mail do cliente na conversa (variável {EMAIL} nos funis — acesso do app vai por login)
        "ALTER TABLE conversations ADD COLUMN customer_email TEXT",
        // ⭐ 22/07: nome e telefone completo no evento (lista de números pra contato manual)
        "ALTER TABLE events ADD COLUMN customer_name TEXT",
        "ALTER TABLE events ADD COLUMN customer_phone TEXT",
        // ⭐ 28/07: nome do perfil do WhatsApp (aparece no chat mesmo sem compra)
        "ALTER TABLE wa_windows ADD COLUMN profile_name TEXT",
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch(e) { /* coluna já existe, ignora */ }
    }

    // ⭐ 22/07: números já contatados manualmente (lista de números marca ao copiar)
    db.exec(`
        CREATE TABLE IF NOT EXISTS contacted_log (
            phone_key TEXT PRIMARY KEY,
            contacted_at TEXT DEFAULT (datetime('now'))
        );
    `);

    // ⭐ 22/07: WhatsApp Cloud API OFICIAL (Meta) — fundação da migração pós-Evolution
    db.exec(`
        -- Números oficiais registrados na WABA (papel, qualidade e limite vêm da Meta)
        CREATE TABLE IF NOT EXISTS official_numbers (
            phone_number_id TEXT PRIMARY KEY,
            display_number TEXT,
            verified_name TEXT,
            label TEXT,
            role TEXT DEFAULT 'transacional',
            quality_rating TEXT,
            messaging_limit TEXT,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT
        );

        -- Log de TODA mensagem da API oficial (base das métricas: entregue/lida/resposta/custo)
        CREATE TABLE IF NOT EXISTS wa_messages (
            wamid TEXT PRIMARY KEY,
            phone_number_id TEXT,
            phone_key TEXT,
            to_phone TEXT,
            direction TEXT,
            msg_type TEXT,
            template_name TEXT,
            category TEXT,
            billable INTEGER,
            status TEXT,
            error TEXT,
            campaign_id TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT
        );

        -- Janela de 24h por cliente (última mensagem RECEBIDA dele; anúncio CTWA guarda o referral)
        CREATE TABLE IF NOT EXISTS wa_windows (
            phone_key TEXT PRIMARY KEY,
            phone TEXT,
            last_inbound_at TEXT,
            last_referral_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone_key, created_at);
    `);

    // Tabela de páginas PIX únicas por cliente
    db.exec(`
        -- ⭐ FIX 11/05: Log de disparos de START_TRIGGER (palavra-chave do anúncio → WhatsApp)
        -- Registra cada vez que um lead novo entra via gatilho de palavra-chave.
        -- Usado pra dashboard de métricas (quantos chegaram via anúncio, quantos converteram).
        CREATE TABLE IF NOT EXISTS start_trigger_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trigger_id INTEGER NOT NULL,
            trigger_name TEXT,
            phone_key TEXT NOT NULL,
            matched_keyword TEXT,
            instance TEXT,
            target_funnel_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_start_trigger_log_phone ON start_trigger_log(phone_key);
        CREATE INDEX IF NOT EXISTS idx_start_trigger_log_date ON start_trigger_log(created_at);

        -- ⭐ FIX 11/05: Tabela de funis agendados (RECUPERAÇÃO 24h pós-completar PIX/ABANDONO)
        -- Funil é registrado aqui quando completar; job a cada 1min processa e dispara se proteções OK.
        CREATE TABLE IF NOT EXISTS scheduled_funnels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_key TEXT NOT NULL,
            remote_jid TEXT,
            customer_name TEXT,
            product_id TEXT,
            product_name TEXT,
            funnel_id TEXT NOT NULL,
            funnel_type TEXT NOT NULL,
            trigger_source TEXT,
            fire_at TEXT NOT NULL,
            fired INTEGER DEFAULT 0,
            cancelled INTEGER DEFAULT 0,
            cancel_reason TEXT,
            fired_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_scheduled_funnels_pending ON scheduled_funnels(fired, cancelled, fire_at);
        CREATE INDEX IF NOT EXISTS idx_scheduled_funnels_phone ON scheduled_funnels(phone_key, fired);

        CREATE TABLE IF NOT EXISTS pix_pages (
            token TEXT PRIMARY KEY,
            phone_key TEXT NOT NULL,
            pix_code TEXT NOT NULL,
            customer_name TEXT,
            amount_display TEXT,
            product_name TEXT,
            product_id TEXT,
            expires_at TEXT NOT NULL,
            products_json TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);

    // Tabela de logs brutos dos webhooks (pra ROI por campanha, debug, replay)
    db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            gateway TEXT NOT NULL,
            event TEXT,
            sale_id TEXT,
            phone_key TEXT,
            customer_email TEXT,
            customer_document TEXT,
            utm_source TEXT,
            utm_campaign TEXT,
            utm_medium TEXT,
            utm_content TEXT,
            utm_term TEXT,
            amount_gross REAL,
            amount_net REAL,
            payload_json TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_logs_sale ON webhook_logs(sale_id);
        CREATE INDEX IF NOT EXISTS idx_webhook_logs_event ON webhook_logs(event);
        CREATE INDEX IF NOT EXISTS idx_webhook_logs_campaign ON webhook_logs(utm_campaign);
        CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at);
    `);

    // Instância de notificações
    db.prepare('INSERT OR IGNORE INTO instances (name, is_notification, paused) VALUES (?, 1, 0)').run('NOTIFICACOES');

    console.log('✅ Banco de dados Orion inicializado');
    return db;
}

// ===== DDD -> LOCALIZAÇÃO =====
const DDD_MAP = {
    '11':'São Paulo,São Paulo','12':'São José dos Campos,São Paulo','13':'Santos,São Paulo','14':'Bauru,São Paulo','15':'Sorocaba,São Paulo',
    '16':'Ribeirão Preto,São Paulo','17':'São José do Rio Preto,São Paulo','18':'Presidente Prudente,São Paulo','19':'Campinas,São Paulo',
    '21':'Rio de Janeiro,Rio de Janeiro','22':'Campos dos Goytacazes,Rio de Janeiro','24':'Volta Redonda,Rio de Janeiro',
    '27':'Vitória,Espírito Santo','28':'Cachoeiro de Itapemirim,Espírito Santo',
    '31':'Belo Horizonte,Minas Gerais','32':'Juiz de Fora,Minas Gerais','33':'Governador Valadares,Minas Gerais','34':'Uberlândia,Minas Gerais',
    '35':'Poços de Caldas,Minas Gerais','37':'Divinópolis,Minas Gerais','38':'Montes Claros,Minas Gerais',
    '41':'Curitiba,Paraná','42':'Ponta Grossa,Paraná','43':'Londrina,Paraná','44':'Maringá,Paraná','45':'Foz do Iguaçu,Paraná','46':'Francisco Beltrão,Paraná',
    '47':'Joinville,Santa Catarina','48':'Florianópolis,Santa Catarina','49':'Chapecó,Santa Catarina',
    '51':'Porto Alegre,Rio Grande do Sul','53':'Pelotas,Rio Grande do Sul','54':'Caxias do Sul,Rio Grande do Sul','55':'Santa Maria,Rio Grande do Sul',
    '61':'Brasília,Distrito Federal','62':'Goiânia,Goiás','63':'Palmas,Tocantins','64':'Rio Verde,Goiás','65':'Cuiabá,Mato Grosso','66':'Rondonópolis,Mato Grosso','67':'Campo Grande,Mato Grosso do Sul','68':'Rio Branco,Acre','69':'Porto Velho,Rondônia',
    '71':'Salvador,Bahia','73':'Ilhéus,Bahia','74':'Juazeiro,Bahia','75':'Feira de Santana,Bahia','77':'Vitória da Conquista,Bahia',
    '79':'Aracaju,Sergipe',
    '81':'Recife,Pernambuco','82':'Maceió,Alagoas','83':'João Pessoa,Paraíba','84':'Natal,Rio Grande do Norte','85':'Fortaleza,Ceará','86':'Teresina,Piauí',
    '87':'Petrolina,Pernambuco','88':'Juazeiro do Norte,Ceará','89':'Picos,Piauí',
    '91':'Belém,Pará','92':'Manaus,Amazonas','93':'Santarém,Pará','94':'Marabá,Pará','95':'Boa Vista,Roraima','96':'Macapá,Amapá','97':'Coari,Amazonas','98':'São Luís,Maranhão','99':'Imperatriz,Maranhão'
};

function getLocationFromPhone(phone) {
    const cleaned = String(phone).replace(/\D/g, '');
    let ddd = '';
    if (cleaned.startsWith('55') && cleaned.length >= 4) ddd = cleaned.substring(2, 4);
    else if (cleaned.length >= 2) ddd = cleaned.substring(0, 2);

    if (DDD_MAP[ddd]) {
        const [city, state] = DDD_MAP[ddd].split(',');
        return { ddd, city, state };
    }
    return { ddd, city: '', state: '' };
}

// ===== PRODUTOS =====
function getProducts() { return getDb().prepare('SELECT * FROM products ORDER BY name').all(); }
function getActiveProducts() { return getDb().prepare('SELECT * FROM products WHERE active = 1').all(); }
function getProductByOfferId(offerId) {
    return getDb().prepare('SELECT p.* FROM products p JOIN product_offers po ON po.product_id = p.id WHERE po.offer_id = ? AND p.active = 1').get(offerId) || null;
}
function saveProduct(product) {
    const d = getDb();
    d.prepare('INSERT OR REPLACE INTO products (id, name, active, ab_funnel_ids) VALUES (?, ?, ?, ?)').run(product.id, product.name, product.active ? 1 : 0, JSON.stringify(product.ab_funnel_ids || []));
    if (product.offers) {
        d.prepare('DELETE FROM product_offers WHERE product_id = ?').run(product.id);
        for (const o of product.offers) d.prepare('INSERT INTO product_offers (product_id, offer_id, platform) VALUES (?, ?, ?)').run(product.id, o.offer_id, o.platform || 'kirvano');
    }
    d.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run(product.id + '_PIX', product.id, 'PIX', product.name + ' - PIX Pendente', '[]');
    d.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run(product.id + '_APROVADA', product.id, 'APROVADA', product.name + ' - Compra Aprovada', '[]');
    d.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run(product.id + '_ABANDONO', product.id, 'ABANDONO', product.name + ' - Carrinho Abandonado', '[]');
    d.prepare('INSERT OR IGNORE INTO funnels (id, product_id, type, name, steps) VALUES (?, ?, ?, ?, ?)').run(product.id + '_CARTAO_RECUSADO', product.id, 'CARTAO_RECUSADO', product.name + ' - Cartão Recusado', '[]');
}
function toggleProduct(productId, active) { getDb().prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, productId); }
function updateProductABFunnels(productId, abFunnelIds) { getDb().prepare('UPDATE products SET ab_funnel_ids = ? WHERE id = ?').run(JSON.stringify(abFunnelIds), productId); }

// ===== EDIÇÃO DE PRODUTOS (v1.1) =====
// Atualiza apenas nome do produto (não mexe no ID porque ID é FK em vários lugares)
function updateProductName(productId, newName) {
    if (!productId || !newName) throw new Error('productId e newName obrigatórios');
    const d = getDb();
    d.prepare('UPDATE products SET name = ? WHERE id = ?').run(newName, productId);
    // Atualiza nomes dos funis padrão também (opcional, melhora UX)
    const types = [
        { suffix: '_PIX', label: ' - PIX Pendente' },
        { suffix: '_APROVADA', label: ' - Compra Aprovada' },
        { suffix: '_ABANDONO', label: ' - Carrinho Abandonado' },
        { suffix: '_CARTAO_RECUSADO', label: ' - Cartão Recusado' }
    ];
    for (const t of types) {
        const f = d.prepare('SELECT id, name FROM funnels WHERE id = ?').get(productId + t.suffix);
        if (f) {
            // Só renomeia se o nome ainda for o automático (preserva nomes customizados)
            // Heurística: se o nome contém o tipo padrão, atualiza
            if (f.name.includes(t.label.trim()) || f.name.endsWith(t.label.trim())) {
                d.prepare('UPDATE funnels SET name = ? WHERE id = ?').run(newName + t.label, f.id);
            }
        }
    }
}

// Atualiza offers vinculados ao produto
function updateProductOffers(productId, offers) {
    if (!productId) throw new Error('productId obrigatório');
    const d = getDb();
    d.prepare('DELETE FROM product_offers WHERE product_id = ?').run(productId);
    if (Array.isArray(offers)) {
        for (const o of offers) {
            if (o && o.offer_id) {
                d.prepare('INSERT INTO product_offers (product_id, offer_id, platform) VALUES (?, ?, ?)').run(productId, o.offer_id, o.platform || 'kirvano');
            }
        }
    }
}

// Pega offers de um produto
function getProductOffers(productId) {
    return getDb().prepare('SELECT * FROM product_offers WHERE product_id = ?').all(productId);
}

// Verifica se produto tem conversas vinculadas (impede deletar)
function getProductConversationCount(productId) {
    try {
        const r = getDb().prepare('SELECT COUNT(*) as n FROM conversations WHERE product_id = ?').get(productId);
        return r ? r.n : 0;
    } catch(e) { return 0; }
}

// Deleta produto (e funis vazios dele) — só se não tiver conversas
function deleteProduct(productId) {
    if (!productId) throw new Error('productId obrigatório');
    const d = getDb();
    const count = getProductConversationCount(productId);
    if (count > 0) throw new Error(`Produto tem ${count} conversa(s) vinculada(s). Não pode ser deletado.`);
    // Deleta funis do produto que estão VAZIOS (steps = '[]')
    const funnels = d.prepare('SELECT id, steps FROM funnels WHERE product_id = ?').all(productId);
    let deletedFunnels = 0, keptFunnels = 0;
    for (const f of funnels) {
        const steps = JSON.parse(f.steps || '[]');
        if (!steps.length) {
            d.prepare('DELETE FROM funnels WHERE id = ?').run(f.id);
            deletedFunnels++;
        } else {
            keptFunnels++;
        }
    }
    if (keptFunnels > 0) throw new Error(`Produto tem ${keptFunnels} funil(is) com passos configurados. Limpe os funis primeiro.`);
    // Deleta offers
    d.prepare('DELETE FROM product_offers WHERE product_id = ?').run(productId);
    // Deleta produto
    d.prepare('DELETE FROM products WHERE id = ?').run(productId);
    return { deletedFunnels };
}

// ===== EDIÇÃO DE FUNIS (v1.1) =====
// Atualiza nome do funil
function updateFunnelName(funnelId, newName) {
    if (!funnelId || !newName) throw new Error('funnelId e newName obrigatórios');
    getDb().prepare('UPDATE funnels SET name = ? WHERE id = ?').run(newName, funnelId);
}

// Move funil para outro produto (muda product_id) e/ou muda tipo
function updateFunnelMeta(funnelId, { name, product_id, type }) {
    if (!funnelId) throw new Error('funnelId obrigatório');
    const d = getDb();
    const current = d.prepare('SELECT * FROM funnels WHERE id = ?').get(funnelId);
    if (!current) throw new Error('Funil não encontrado');
    const newName = name || current.name;
    const newProductId = product_id || current.product_id;
    const newType = type || current.type;
    d.prepare('UPDATE funnels SET name = ?, product_id = ?, type = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newName, newProductId, newType, funnelId);
}

// Verifica se funil tem conversas ativas
function getFunnelActiveConversationCount(funnelId) {
    try {
        const r = getDb().prepare("SELECT COUNT(*) as n FROM conversations WHERE funnel_id = ? AND completed = 0 AND canceled = 0").get(funnelId);
        return r ? r.n : 0;
    } catch(e) { return 0; }
}

// Deleta funil (só se não tiver conversas ativas)
function deleteFunnel(funnelId) {
    if (!funnelId) throw new Error('funnelId obrigatório');
    const count = getFunnelActiveConversationCount(funnelId);
    if (count > 0) throw new Error(`Funil tem ${count} conversa(s) ativa(s). Não pode ser deletado.`);
    getDb().prepare('DELETE FROM funnels WHERE id = ?').run(funnelId);
}

// Cria funil novo do zero
function createFunnel({ id, product_id, type, name }) {
    if (!id || !product_id || !type || !name) throw new Error('id, product_id, type e name são obrigatórios');
    const d = getDb();
    const exists = d.prepare('SELECT id FROM funnels WHERE id = ?').get(id);
    if (exists) throw new Error('Já existe um funil com este ID');
    d.prepare("INSERT INTO funnels (id, product_id, type, name, steps, enabled) VALUES (?, ?, ?, ?, '[]', 1)").run(id, product_id, type, name);
    return id;
}

// ===== FUNIS =====
function getFunnels() {
    return getDb().prepare('SELECT * FROM funnels ORDER BY product_id, type').all().map(f => ({ ...f, steps: JSON.parse(f.steps || '[]') }));
}
function getFunnelById(id) {
    const f = getDb().prepare('SELECT * FROM funnels WHERE id = ?').get(id);
    return f ? { ...f, steps: JSON.parse(f.steps || '[]') } : null;
}
function saveFunnel(funnel) {
    getDb().prepare("INSERT OR REPLACE INTO funnels (id, product_id, type, name, steps, ab_enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))").run(funnel.id, funnel.product_id || 'GRUPO_VIP', funnel.type || 'PIX', funnel.name, JSON.stringify(funnel.steps || []), funnel.ab_enabled ? 1 : 0);
}
function recordABResult(funnelId, converted) {
    const field = converted ? 'ab_conversions = ab_conversions + 1, ab_leads = ab_leads + 1' : 'ab_leads = ab_leads + 1';
    getDb().prepare(`UPDATE funnels SET ${field} WHERE id = ?`).run(funnelId);
}

// ===== GATILHOS =====
function getTriggers() { return getDb().prepare('SELECT * FROM triggers WHERE active = 1 ORDER BY id').all(); }
function saveTrigger(trigger) {
    if (trigger.id) {
        getDb().prepare('UPDATE triggers SET name=?, keywords=?, match_type=?, target_funnel_id=?, auto_block=?, active=? WHERE id=?').run(trigger.name, trigger.keywords, trigger.match_type || 'contains', trigger.target_funnel_id || null, trigger.auto_block ? 1 : 0, trigger.active ? 1 : 0, trigger.id);
    } else {
        getDb().prepare('INSERT INTO triggers (name, keywords, match_type, target_funnel_id, auto_block, active) VALUES (?, ?, ?, ?, ?, 1)').run(trigger.name, trigger.keywords, trigger.match_type || 'contains', trigger.target_funnel_id || null, trigger.auto_block ? 1 : 0);
    }
}
function deleteTrigger(id) { getDb().prepare('DELETE FROM triggers WHERE id = ?').run(id); }

// ===== BLACKLIST =====
function isBlacklisted(phoneKey) { return !!getDb().prepare('SELECT 1 FROM blacklist WHERE phone_key = ?').get(phoneKey); }
function addToBlacklist(phoneKey, phone, reason) { getDb().prepare('INSERT OR IGNORE INTO blacklist (phone_key, phone, reason) VALUES (?, ?, ?)').run(phoneKey, phone, reason); }
function getBlacklist() { return getDb().prepare('SELECT * FROM blacklist ORDER BY created_at DESC').all(); }
function removeFromBlacklist(phoneKey) { getDb().prepare('DELETE FROM blacklist WHERE phone_key = ?').run(phoneKey); }

// ===== CONVERSAS =====
function getConversation(phoneKey) {
    const c = getDb().prepare('SELECT * FROM conversations WHERE phone_key = ?').get(phoneKey);
    return c ? { ...c, order_bumps: JSON.parse(c.order_bumps || '[]') } : null;
}
function saveConversation(conv) {
    getDb().prepare(`INSERT OR REPLACE INTO conversations
        (phone_key, remote_jid, funnel_id, step_index, order_code, customer_name, product_id, product_name,
         order_bumps, amount, amount_display, net_value, pix_code, checkout_url, payment_method, ddd, city, state,
         waiting_for_response, pix_waiting, sticky_instance, canceled, completed, has_error, invalid_number,
         transferred_from_pix, paused, reactivation, ab_funnel_variant, created_at, last_message_at, last_reply_at, completed_at, canceled_at,
         awaiting_pool, waiting_for_sticky_return, funnel_type, last_send_error, customer_email)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(conv.phone_key, conv.remote_jid, conv.funnel_id, conv.step_index, conv.order_code, conv.customer_name,
        conv.product_id, conv.product_name, JSON.stringify(conv.order_bumps || []),
        conv.amount || 0, conv.amount_display, conv.net_value || 0, conv.pix_code, conv.checkout_url || null, conv.payment_method || 'PIX',
        conv.ddd, conv.city, conv.state,
        conv.waiting_for_response ? 1 : 0, conv.pix_waiting ? 1 : 0, conv.sticky_instance,
        conv.canceled ? 1 : 0, conv.completed ? 1 : 0, conv.has_error ? 1 : 0, conv.invalid_number ? 1 : 0,
        conv.transferred_from_pix ? 1 : 0, conv.paused ? 1 : 0, conv.reactivation ? 1 : 0,
        conv.ab_funnel_variant, conv.created_at, conv.last_message_at, conv.last_reply_at, conv.completed_at, conv.canceled_at,
        conv.awaiting_pool ? 1 : 0, conv.waiting_for_sticky_return ? 1 : 0, conv.funnel_type || null, conv.last_send_error || null, conv.customer_email || null);
}
function getConversations(limit = 200) {
    return getDb().prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT ?').all(limit).map(c => ({ ...c, order_bumps: JSON.parse(c.order_bumps || '[]') }));
}
function getCompletedConversationsByPhone(phoneKey) {
    return getDb().prepare("SELECT * FROM conversations WHERE phone_key = ? AND (completed = 1 OR canceled = 1) ORDER BY created_at DESC").all(phoneKey);
}
function deleteOldConversations(days = 7) {
    return getDb().prepare("DELETE FROM conversations WHERE (completed=1 OR canceled=1) AND datetime(created_at) < datetime('now', '-' || ? || ' days')").run(days).changes;
}

// ===== EVENTOS =====
function recordEvent(type, data) {
    getDb().prepare('INSERT INTO events (type, phone_key, product_id, product_name, amount, net_value, payment_method, order_code, order_bumps, instance, funnel_id, extra, customer_name, customer_phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(type, data.phone_key, data.product_id, data.product_name, data.amount || 0, data.net_value || 0, data.payment_method, data.order_code, JSON.stringify(data.order_bumps || []), data.instance, data.funnel_id, data.extra ? JSON.stringify(data.extra) : null, data.customer_name || null, data.customer_phone || null);
}
function getEventStats(days = 7) {
    // created_at é UTC; ajusta -3h para agrupar por dia do Brasil
    return getDb().prepare(`SELECT date(datetime(created_at, '-3 hours')) as day,
        SUM(CASE WHEN type='PIX_GENERATED' THEN 1 ELSE 0 END) as pix_generated,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN type='PIX_PAID' THEN 1 ELSE 0 END) as pix_paid,
        SUM(CASE WHEN type='CARD_PAID' THEN 1 ELSE 0 END) as card_paid,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(amount,0) ELSE 0 END) as revenue_gross,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as revenue
        FROM events WHERE datetime(created_at, '-3 hours') >= datetime('now', '-3 hours', '-' || ? || ' days')
        GROUP BY date(datetime(created_at, '-3 hours')) ORDER BY day DESC`).all(days);
}
function getTodayStats(todayDate) {
    // created_at é UTC; ajusta -3h antes de comparar a data (horário de Brasília)
    // Aceita parâmetro opcional; se não vier, usa hoje em Brasília
    if (!todayDate) {
        const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
        todayDate = now.toISOString().split('T')[0];
    }
    return getDb().prepare(`SELECT
        SUM(CASE WHEN type='PIX_GENERATED' THEN 1 ELSE 0 END) as pix_generated,
        SUM(CASE WHEN type='PIX_PAID' THEN 1 ELSE 0 END) as pix_paid,
        SUM(CASE WHEN type='CARD_PAID' THEN 1 ELSE 0 END) as card_paid,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(amount,0) ELSE 0 END) as revenue_gross,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as revenue
        FROM events WHERE date(datetime(created_at, '-3 hours')) = ?`).get(todayDate) || { pix_generated: 0, pix_paid: 0, card_paid: 0, revenue: 0, revenue_gross: 0 };
}
function getPeriodStats(startDate, endDate) {
    return getDb().prepare(`SELECT
        SUM(CASE WHEN type='PIX_GENERATED' THEN 1 ELSE 0 END) as pix_generated,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as revenue
        FROM events WHERE date(created_at) BETWEEN ? AND ?`).get(startDate, endDate);
}

// ===== MENSAGENS =====
function logMessage(phoneKey, direction, content, instance, stepId, delivered = true) {
    getDb().prepare('INSERT INTO messages_log (phone_key, direction, content, instance, step_id, delivered) VALUES (?, ?, ?, ?, ?, ?)').run(phoneKey, direction, content ? content.substring(0, 500) : null, instance, stepId, delivered ? 1 : 0);
    if (direction === 'in') processWordFrequency(content, null);
}
function processWordFrequency(text, productId) {
    if (!text || text.length < 2 || text.startsWith('[')) return;
    const stopWords = new Set(['o','a','os','as','um','uma','de','da','do','em','no','na','por','para','com','que','se','não','nao','sim','ok','oi','ola','olá','e','é','eu','me','te','seu','sua','meu','minha','ai','aí','né','ne','ta','tá','tô','to']);
    const words = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !stopWords.has(w));
    for (const word of words) {
        getDb().prepare("INSERT INTO word_frequency (word, product_id, count, last_seen) VALUES (?, ?, 1, datetime('now')) ON CONFLICT(word, product_id) DO UPDATE SET count = count + 1, last_seen = datetime('now')").run(word, productId || 'ALL');
    }
}
function getTopWords(productId, limit = 30) {
    return productId && productId !== 'ALL'
        ? getDb().prepare('SELECT word, count FROM word_frequency WHERE product_id = ? ORDER BY count DESC LIMIT ?').all(productId, limit)
        : getDb().prepare('SELECT word, SUM(count) as count FROM word_frequency GROUP BY word ORDER BY count DESC LIMIT ?').all(limit);
}

// ===== INSTÂNCIAS =====
function ensureInstance(name, isNotification = false) {
    getDb().prepare('INSERT OR IGNORE INTO instances (name, is_notification) VALUES (?, ?)').run(name, isNotification ? 1 : 0);
}
function getInstances() { return getDb().prepare('SELECT * FROM instances ORDER BY is_notification, name').all(); }
function updateInstanceStats(name, messagesSent = 0, converted = false) {
    const today = new Date().toISOString().split('T')[0];
    getDb().prepare("UPDATE instances SET messages_total = messages_total + ?, last_seen = datetime('now') WHERE name = ?").run(messagesSent, name);
    if (converted) getDb().prepare('UPDATE instances SET conversions = conversions + 1 WHERE name = ?').run(name);
    getDb().prepare("INSERT INTO instance_daily_stats (instance, date, messages_sent) VALUES (?, ?, ?) ON CONFLICT(instance, date) DO UPDATE SET messages_sent = messages_sent + ?").run(name, today, messagesSent, messagesSent);
    if (converted) getDb().prepare("INSERT INTO instance_daily_stats (instance, date, conversions) VALUES (?, ?, 1) ON CONFLICT(instance, date) DO UPDATE SET conversions = conversions + 1").run(name, today);
}
function getInstanceStats(days = 7) {
    return getDb().prepare('SELECT instance, date, messages_sent, leads_attended, conversions FROM instance_daily_stats WHERE datetime(date) >= datetime(\'now\', \'-\' || ? || \' days\') ORDER BY date DESC, messages_sent DESC').all(days);
}
function setInstancePaused(name, paused) { getDb().prepare('UPDATE instances SET paused = ? WHERE name = ?').run(paused ? 1 : 0, name); }
function setInstanceConnected(name, connected) {
    const now = new Date().toISOString();
    connected
        ? getDb().prepare("UPDATE instances SET connected = 1, last_connected = ? WHERE name = ?").run(now, name)
        : getDb().prepare("UPDATE instances SET connected = 0, last_disconnected = ? WHERE name = ?").run(now, name);
}
function getFunnelDropoff() {
    return getDb().prepare('SELECT funnel_id, step_index, COUNT(*) as count FROM conversations WHERE waiting_for_response = 1 AND canceled = 0 AND completed = 0 GROUP BY funnel_id, step_index ORDER BY count DESC').all();
}
// ===== SYSTEM SETTINGS =====
function getSetting(key, defaultValue = null) {
    const row = getDb().prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
}
function setSetting(key, value) {
    getDb().prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, String(value));
}
function getAllSettings() {
    const rows = getDb().prepare('SELECT key, value FROM system_settings').all();
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    return settings;
}

// ===== PHONE VARIATION LOG =====
function logPhoneVariation(originalPhone, workingVariation, failedVariations, success) {
    getDb().prepare('INSERT INTO phone_variation_log (original_phone, working_variation, failed_variations, success) VALUES (?, ?, ?, ?)').run(originalPhone, workingVariation || null, JSON.stringify(failedVariations || []), success ? 1 : 0);
}
function getWorkingVariation(originalPhone) {
    const row = getDb().prepare('SELECT working_variation FROM phone_variation_log WHERE original_phone = ? AND success = 1 ORDER BY id DESC LIMIT 1').get(originalPhone);
    return row?.working_variation || null;
}

// ===== INSTANCE HEALTH =====
function updateInstanceHealth(name, success, isInvalidNumber = false) {
    getDb().prepare(`INSERT INTO instance_health (instance, total_sends, failed_sends, invalid_numbers, last_checked)
        VALUES (?, 1, ?, ?, datetime('now'))
        ON CONFLICT(instance) DO UPDATE SET
        total_sends = total_sends + 1,
        failed_sends = failed_sends + ?,
        invalid_numbers = invalid_numbers + ?,
        last_checked = datetime('now')`)
    .run(name, success ? 0 : 1, isInvalidNumber ? 1 : 0, success ? 0 : 1, isInvalidNumber ? 1 : 0);
    // Recalcula score
    const h = getDb().prepare('SELECT * FROM instance_health WHERE instance = ?').get(name);
    if (h && h.total_sends > 0) {
        const errorRate = h.failed_sends / h.total_sends;
        const invalidRate = h.invalid_numbers / h.total_sends;
        const score = Math.max(0, Math.round(100 - (errorRate * 60) - (invalidRate * 40)));
        getDb().prepare('UPDATE instance_health SET score = ? WHERE instance = ?').run(score, name);
    }
}
function getInstanceHealth() {
    return getDb().prepare('SELECT * FROM instance_health ORDER BY score ASC').all();
}

// Efetividade dos funis: quantos leads que RECEBERAM cada funil acabaram pagando depois.
// Cruza funnel_receipts (funil enviado) com events PIX_PAID/CARD_PAID posteriores (janela de 48h).
// Funciona retroativamente com o histórico existente — não depende de flag nova.
function getFunnelEffectiveness(days = 7) {
    const d = parseInt(days) || 7;
    const types = ['PIX', 'ABANDONO', 'CARTAO_RECUSADO', 'RECUPERACAO'];
    const result = {};
    for (const type of types) {
        const row = getDb().prepare(`
            SELECT
                COUNT(DISTINCT fr.phone_key) as leads_received,
                COUNT(DISTINCT CASE WHEN EXISTS (
                    SELECT 1 FROM events e
                    WHERE e.phone_key = fr.phone_key
                      AND e.type IN ('PIX_PAID','CARD_PAID')
                      AND datetime(e.created_at) > datetime(fr.received_at)
                      AND datetime(e.created_at) < datetime(fr.received_at, '+48 hours')
                ) THEN fr.phone_key END) as converted
            FROM funnel_receipts fr
            WHERE datetime(fr.received_at) >= datetime('now', '-' || ? || ' days') AND fr.funnel_type = ?
        `).get(d, type) || {};
        const received = row.leads_received || 0;
        const converted = row.converted || 0;
        result[type] = {
            leads_received: received,
            converted,
            rate: received > 0 ? +(converted / received * 100).toFixed(1) : 0
        };
    }
    // Atividade de mensagens no período (controle anti-ban + engajamento)
    const msgs = getDb().prepare(`
        SELECT
            COUNT(CASE WHEN direction='out' THEN 1 END) as sent,
            COUNT(DISTINCT CASE WHEN direction='out' THEN phone_key END) as leads_messaged,
            COUNT(DISTINCT CASE WHEN direction='in' THEN phone_key END) as leads_replied
        FROM messages_log WHERE datetime(created_at) >= datetime('now', '-' || ? || ' days')
    `).get(d) || {};
    result.messages = {
        sent: msgs.sent || 0,
        leads_messaged: msgs.leads_messaged || 0,
        leads_replied: msgs.leads_replied || 0,
        reply_rate: (msgs.leads_messaged || 0) > 0 ? +((msgs.leads_replied || 0) / msgs.leads_messaged * 100).toFixed(1) : 0
    };
    return result;
}

// ===== FUNNEL RECEIPTS (anti-duplicata com cooldown) =====
function recordFunnelReceipt(phoneKey, productId, funnelType, funnelId) {
    try {
        getDb().prepare('INSERT INTO funnel_receipts (phone_key, product_id, funnel_type, funnel_id) VALUES (?, ?, ?, ?)')
            .run(phoneKey, productId, funnelType, funnelId || null);
    } catch(e) {}
}
function hasReceivedFunnelRecently(phoneKey, productId, funnelType, cooldownDays) {
    const days = parseInt(cooldownDays) || 7;
    const row = getDb().prepare(`SELECT id, received_at FROM funnel_receipts 
        WHERE phone_key=? AND product_id=? AND funnel_type=? 
        AND datetime(received_at) >= datetime('now', '-' || ? || ' days')
        ORDER BY received_at DESC LIMIT 1`).get(phoneKey, productId, funnelType, days);
    return row || null;
}
function cleanOldFunnelReceipts(days = 30) {
    try {
        getDb().prepare("DELETE FROM funnel_receipts WHERE datetime(received_at) < datetime('now', '-' || ? || ' days')").run(days);
    } catch(e) {}
}
// ⭐ FIX 04/05: ao pagar, apaga o receipt PIX pra liberar recompra do mesmo produto sem bloqueio de cooldown.
// Sem isso: cliente que paga e gera novo PIX em 7 dias não recebe funil PIX (porque "já recebeu").
function clearFunnelReceiptOnPayment(phoneKey, productId) {
    try {
        getDb().prepare(`DELETE FROM funnel_receipts WHERE phone_key=? AND product_id=? AND funnel_type='PIX'`).run(phoneKey, productId);
    } catch(e) {}
}

// ⭐ FIX 11/05: Verifica se cliente JÁ PAGOU alguma vez (ticket cheio R$19,99/R$29,99/etc).
// Crítico pra proteção do funil de RECUPERAÇÃO — cliente pagante NÃO recebe oferta de R$9,99.
// Se já comprou em qualquer momento, é cliente premium, não desconta.
function hasEverPaid(phoneKey) {
    try {
        const row = getDb().prepare(
            `SELECT 1 FROM events WHERE phone_key = ? AND type IN ('PIX_PAID','CARD_PAID') LIMIT 1`
        ).get(phoneKey);
        return !!row;
    } catch(e) { return false; }
}

// ===== SCHEDULED FUNNELS (recuperação 24h) =====
function scheduleFunnel(data) {
    try {
        // Evita duplicidade: se já tem agendamento pendente do mesmo trigger pro mesmo phoneKey, não duplica
        const existing = getDb().prepare(
            `SELECT id FROM scheduled_funnels
             WHERE phone_key=? AND trigger_source=? AND fired=0 AND cancelled=0
             ORDER BY id DESC LIMIT 1`
        ).get(data.phone_key, data.trigger_source);
        if (existing) return existing.id;
        const r = getDb().prepare(
            `INSERT INTO scheduled_funnels
             (phone_key, remote_jid, customer_name, product_id, product_name, funnel_id, funnel_type, trigger_source, fire_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            data.phone_key, data.remote_jid || null, data.customer_name || null,
            data.product_id || null, data.product_name || null,
            data.funnel_id, data.funnel_type, data.trigger_source || null, data.fire_at
        );
        return r.lastInsertRowid;
    } catch(e) { return null; }
}

function getPendingScheduledFunnels() {
    try {
        return getDb().prepare(
            `SELECT * FROM scheduled_funnels
             WHERE fired=0 AND cancelled=0 AND datetime(fire_at) <= datetime('now')
             ORDER BY fire_at ASC LIMIT 100`
        ).all();
    } catch(e) { return []; }
}

function markScheduledFunnelFired(id) {
    try {
        getDb().prepare(`UPDATE scheduled_funnels SET fired=1, fired_at=datetime('now') WHERE id=?`).run(id);
    } catch(e) {}
}

function cancelScheduledFunnel(id, reason) {
    try {
        getDb().prepare(`UPDATE scheduled_funnels SET cancelled=1, cancel_reason=?, fired_at=datetime('now') WHERE id=?`).run(reason || 'unknown', id);
    } catch(e) {}
}

function cancelScheduledFunnelsByPhone(phoneKey, reason) {
    try {
        const r = getDb().prepare(
            `UPDATE scheduled_funnels SET cancelled=1, cancel_reason=?, fired_at=datetime('now')
             WHERE phone_key=? AND fired=0 AND cancelled=0`
        ).run(reason || 'unknown', phoneKey);
        return r.changes || 0;
    } catch(e) { return 0; }
}

// Stats do funil de RECUPERAÇÃO pra mostrar no dashboard (last-touch attribution já cobre)
function getRecoveryStats(targetDate) {
    if (!targetDate) {
        const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
        targetDate = now.toISOString().split('T')[0];
    }
    try {
        const scheduled = getDb().prepare(
            `SELECT COUNT(*) as n FROM scheduled_funnels
             WHERE date(datetime(created_at, '-3 hours')) = ?`
        ).get(targetDate)?.n || 0;
        const fired = getDb().prepare(
            `SELECT COUNT(*) as n FROM scheduled_funnels
             WHERE date(datetime(fired_at, '-3 hours')) = ? AND fired=1`
        ).get(targetDate)?.n || 0;
        const cancelled = getDb().prepare(
            `SELECT COUNT(*) as n, cancel_reason FROM scheduled_funnels
             WHERE date(datetime(fired_at, '-3 hours')) = ? AND cancelled=1
             GROUP BY cancel_reason`
        ).all(targetDate);
        return {
            scheduled,
            fired,
            cancelled_total: cancelled.reduce((s, r) => s + r.n, 0),
            cancelled_breakdown: cancelled
        };
    } catch(e) { return { scheduled: 0, fired: 0, cancelled_total: 0, cancelled_breakdown: [] }; }
}

// ⭐ FIX 10/05: Breakdown de performance por tipo de funil (PIX, APROVADA, ABANDONO, CARTAO_RECUSADO, REATIVACAO, DIRETO).
// Lógica: last-touch attribution — cada evento (PIX_GENERATED, PIX_PAID, CARD_PAID) é atribuído ao
// ÚLTIMO funnel_receipt do lead ANTERIOR ao evento. Se não tem receipt antes, vira "DIRETO".
// Pra cada tipo de funil retorna:
//   - leads:    leads únicos que receberam o funil naquele dia (mensagens disparadas)
//   - pix:      PIX gerados atribuídos ao funil
//   - sales:    vendas (PIX_PAID + CARD_PAID) atribuídas ao funil
//   - revenue:  faturamento líquido das vendas atribuídas
//   - conv_rate: taxa de conversão (sales / leads * 100)
function getFunnelTypeBreakdown(targetDate) {
    if (!targetDate) {
        const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
        targetDate = now.toISOString().split('T')[0];
    }

    // 1) Leads únicos que receberam cada funil_type naquele dia
    const leadsByType = getDb().prepare(`
        SELECT funnel_type, COUNT(DISTINCT phone_key) as leads
        FROM funnel_receipts
        WHERE date(datetime(received_at, '-3 hours')) = ?
        GROUP BY funnel_type
    `).all(targetDate);

    // 2) Eventos do dia com attribution last-touch
    const eventsAttributed = getDb().prepare(`
        SELECT
            COALESCE(
                (SELECT funnel_type FROM funnel_receipts fr
                 WHERE fr.phone_key = e.phone_key
                   AND datetime(fr.received_at) <= datetime(e.created_at)
                 ORDER BY fr.received_at DESC LIMIT 1),
                'DIRETO'
            ) AS funnel_type,
            e.type as evt,
            COALESCE(e.net_value, e.amount, 0) as net
        FROM events e
        WHERE e.type IN ('PIX_GENERATED','PIX_PAID','CARD_PAID')
          AND date(datetime(e.created_at, '-3 hours')) = ?
          AND e.phone_key IS NOT NULL
    `).all(targetDate);

    // Agrega em memória
    const byType = {};
    const ensure = (t) => {
        if (!byType[t]) byType[t] = { funnel_type: t, leads: 0, pix: 0, sales: 0, revenue: 0 };
        return byType[t];
    };
    for (const row of leadsByType) ensure(row.funnel_type).leads = row.leads;
    for (const e of eventsAttributed) {
        const b = ensure(e.funnel_type);
        if (e.evt === 'PIX_GENERATED') b.pix++;
        else { b.sales++; b.revenue += Number(e.net) || 0; }
    }

    // Calcula taxa de conversão e ordena (ABANDONO/PIX/APROVADA primeiro, resto depois)
    const order = { ABANDONO: 1, PIX: 2, APROVADA: 3, CARTAO_RECUSADO: 4, REATIVACAO: 5, DIRETO: 6 };
    const list = Object.values(byType).map(b => ({
        ...b,
        conv_rate: b.leads > 0 ? +(b.sales / b.leads * 100).toFixed(1) : 0,
        pix_to_sale_rate: b.pix > 0 ? +(b.sales / b.pix * 100).toFixed(1) : 0
    })).sort((a, b) => (order[a.funnel_type] || 99) - (order[b.funnel_type] || 99));

    return list;
}

// ===== INSTÂNCIAS DE ABANDONO =====
function getAbandonoInstances() {
    return getDb().prepare('SELECT * FROM instances WHERE is_abandono=1 AND paused=0 AND connected=1').all();
}
function setInstanceAbandono(name, isAbandono) {
    getDb().prepare('UPDATE instances SET is_abandono=? WHERE name=?').run(isAbandono ? 1 : 0, name);
}

// ===== IDENTIFICAÇÃO CELULAR/CHIP/NÚMERO =====
function updateInstanceIdentity(name, { phone_number, device_name, device_slot, account_type }) {
    const clean = (v) => (v === undefined || v === null) ? null : String(v).trim() || null;
    getDb().prepare(`
        UPDATE instances
        SET phone_number = ?, device_name = ?, device_slot = ?, account_type = ?
        WHERE name = ?
    `).run(clean(phone_number), clean(device_name), clean(device_slot), clean(account_type), name);
}
function getInstanceIdentity(name) {
    return getDb().prepare('SELECT name, phone_number, device_name, device_slot, account_type FROM instances WHERE name = ?').get(name);
}

// ===== TIMERS PIX PENDENTES (ROLLBACK SEGURO) =====
function savePixTimeout(phoneKey, orderCode, fireAt) {
    getDb().prepare(`
        INSERT OR REPLACE INTO pending_pix_timeouts (phone_key, order_code, fire_at, created_at)
        VALUES (?, ?, ?, datetime('now'))
    `).run(phoneKey, orderCode, fireAt);
}
function deletePixTimeout(phoneKey) {
    getDb().prepare('DELETE FROM pending_pix_timeouts WHERE phone_key = ?').run(phoneKey);
}
function getAllPendingPixTimeouts() {
    return getDb().prepare('SELECT * FROM pending_pix_timeouts').all();
}
function cleanExpiredPixTimeouts() {
    // remove timers expirados há mais de 1 dia (lixo)
    getDb().prepare(`DELETE FROM pending_pix_timeouts WHERE fire_at < datetime('now', '-1 day')`).run();
}

// ===== SAÚDE POR NÚMERO DE WHATSAPP =====
// Número é a fonte da verdade — instância é só o "slot" onde ele está conectado
function upsertPhoneNumber(phoneNumber, { instance, device_name, device_slot, account_type, notes } = {}) {
    if (!phoneNumber) return;
    const clean = (v) => (v === undefined || v === null) ? null : String(v).trim() || null;
    const existing = getDb().prepare('SELECT * FROM phone_numbers WHERE phone_number = ?').get(phoneNumber);
    if (existing) {
        // Atualiza só o que veio preenchido (não apaga dado existente)
        getDb().prepare(`
            UPDATE phone_numbers
            SET current_instance = COALESCE(?, current_instance),
                last_known_instance = COALESCE(?, last_known_instance),
                device_name = COALESCE(?, device_name),
                device_slot = COALESCE(?, device_slot),
                account_type = COALESCE(?, account_type),
                notes = COALESCE(?, notes),
                last_seen_at = datetime('now')
            WHERE phone_number = ?
        `).run(clean(instance), clean(instance), clean(device_name), clean(device_slot), clean(account_type), clean(notes), phoneNumber);
    } else {
        getDb().prepare(`
            INSERT INTO phone_numbers (phone_number, current_instance, last_known_instance, device_name, device_slot, account_type, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(phoneNumber, clean(instance), clean(instance), clean(device_name), clean(device_slot), clean(account_type), clean(notes));
    }
}

function updatePhoneIdentity(phoneNumber, { device_name, device_slot, account_type, notes, status }) {
    const clean = (v) => (v === undefined || v === null) ? null : String(v).trim() || null;
    getDb().prepare(`
        UPDATE phone_numbers
        SET device_name = ?, device_slot = ?, account_type = ?, notes = ?, status = COALESCE(?, status)
        WHERE phone_number = ?
    `).run(clean(device_name), clean(device_slot), clean(account_type), clean(notes), clean(status), phoneNumber);
}

function getPhoneNumber(phoneNumber) {
    return getDb().prepare('SELECT * FROM phone_numbers WHERE phone_number = ?').get(phoneNumber);
}

function getAllPhoneNumbers() {
    return getDb().prepare('SELECT * FROM phone_numbers ORDER BY last_seen_at DESC').all();
}

function getPhoneNumberByInstance(instance) {
    if (!instance) return null;
    return getDb().prepare('SELECT * FROM phone_numbers WHERE current_instance = ? ORDER BY last_seen_at DESC LIMIT 1').get(instance);
}

// Registra queda (desconexão). Tipo pode ser UNKNOWN, BAN, DISCONNECT
function recordPhoneDrop(phoneNumber, instance, dropType = 'UNKNOWN') {
    if (!phoneNumber) return null;
    const result = getDb().prepare(`
        INSERT INTO phone_drops (phone_number, instance_name, drop_type, dropped_at)
        VALUES (?, ?, ?, datetime('now'))
    `).run(phoneNumber, instance || null, dropType);

    // Atualiza contadores na tabela phone_numbers
    getDb().prepare(`
        UPDATE phone_numbers
        SET total_drops = total_drops + 1,
            ${dropType === 'BAN' ? 'total_bans = total_bans + 1,' : ''}
            ${dropType === 'DISCONNECT' ? 'total_disconnects = total_disconnects + 1,' : ''}
            last_drop_at = datetime('now'),
            status = CASE WHEN ? = 'BAN' THEN 'BANNED' ELSE status END
        WHERE phone_number = ?
    `).run(dropType, phoneNumber);
    return result.lastInsertRowid;
}

function recordPhoneRecovery(phoneNumber) {
    if (!phoneNumber) return;
    // Marca a última queda pendente como recuperada
    getDb().prepare(`
        UPDATE phone_drops
        SET recovered_at = datetime('now'),
            duration_seconds = CAST((julianday('now') - julianday(dropped_at)) * 86400 AS INTEGER)
        WHERE phone_number = ? AND recovered_at IS NULL
    `).run(phoneNumber);
    getDb().prepare(`
        UPDATE phone_numbers SET last_recovery_at = datetime('now'), status = CASE WHEN status='BANNED' THEN status ELSE 'ACTIVE' END WHERE phone_number = ?
    `).run(phoneNumber);
}

// Reclassifica uma queda (ex: usuário marca como "era só desconexão técnica")
function reclassifyDrop(dropId, newType) {
    const drop = getDb().prepare('SELECT * FROM phone_drops WHERE id = ?').get(dropId);
    if (!drop) return false;
    const oldType = drop.drop_type;
    if (oldType === newType) return true;

    getDb().prepare('UPDATE phone_drops SET drop_type = ? WHERE id = ?').run(newType, dropId);

    // Reajusta contadores
    const phone = drop.phone_number;
    if (oldType === 'BAN') getDb().prepare('UPDATE phone_numbers SET total_bans = MAX(0, total_bans - 1) WHERE phone_number = ?').run(phone);
    if (oldType === 'DISCONNECT') getDb().prepare('UPDATE phone_numbers SET total_disconnects = MAX(0, total_disconnects - 1) WHERE phone_number = ?').run(phone);
    if (newType === 'BAN') getDb().prepare('UPDATE phone_numbers SET total_bans = total_bans + 1 WHERE phone_number = ?').run(phone);
    if (newType === 'DISCONNECT') getDb().prepare('UPDATE phone_numbers SET total_disconnects = total_disconnects + 1 WHERE phone_number = ?').run(phone);

    // Se reclassificou de BAN pra algo, libera status
    if (oldType === 'BAN' && newType !== 'BAN') {
        getDb().prepare(`UPDATE phone_numbers SET status = 'ACTIVE' WHERE phone_number = ? AND status = 'BANNED'`).run(phone);
    }
    // Se marcou como BAN, coloca status BANNED
    if (newType === 'BAN') {
        getDb().prepare(`UPDATE phone_numbers SET status = 'BANNED' WHERE phone_number = ?`).run(phone);
    }
    return true;
}

function getPhoneDrops(phoneNumber, limit = 50) {
    return getDb().prepare('SELECT * FROM phone_drops WHERE phone_number = ? ORDER BY dropped_at DESC LIMIT ?').all(phoneNumber, limit);
}

function getAllPhoneDrops(limit = 100) {
    return getDb().prepare('SELECT * FROM phone_drops ORDER BY dropped_at DESC LIMIT ?').all(limit);
}

function incrementPhoneMessages(phoneNumber, count = 1) {
    if (!phoneNumber) return;
    const today = new Date().toISOString().split('T')[0];
    getDb().prepare(`
        INSERT INTO phone_messages_daily (phone_number, date, messages_sent)
        VALUES (?, ?, ?)
        ON CONFLICT(phone_number, date) DO UPDATE SET messages_sent = messages_sent + ?
    `).run(phoneNumber, today, count, count);
    getDb().prepare(`UPDATE phone_numbers SET total_messages_sent = total_messages_sent + ? WHERE phone_number = ?`).run(count, phoneNumber);
}

function getPhoneMessageStats(phoneNumber, days = 30) {
    return getDb().prepare(`
        SELECT date, messages_sent FROM phone_messages_daily
        WHERE phone_number = ? AND date >= date('now', '-' || ? || ' days')
        ORDER BY date DESC
    `).all(phoneNumber, days);
}

function getPhoneSummary() {
    // Agrupa por device_name (celular físico) para visão geral
    return getDb().prepare(`
        SELECT
            COALESCE(device_name, 'Não identificado') as device_name,
            COUNT(*) as total_numbers,
            SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN status = 'BANNED' THEN 1 ELSE 0 END) as banned,
            SUM(total_drops) as all_drops,
            SUM(total_bans) as all_bans
        FROM phone_numbers
        GROUP BY device_name
    `).all();
}


// ===== START TRIGGERS (gatilhos de início — disparam funil pra lead novo) =====
function getStartTriggers() {
    return getDb().prepare('SELECT * FROM start_triggers ORDER BY active DESC, id DESC').all();
}

function getActiveStartTriggers() {
    return getDb().prepare('SELECT * FROM start_triggers WHERE active = 1 ORDER BY id').all();
}

function saveStartTrigger(trigger) {
    if (trigger.id) {
        getDb().prepare(`
            UPDATE start_triggers
               SET name = ?, keywords = ?, match_type = ?,
                   target_funnel_id = ?, target_product_id = ?,
                   instances = ?, active = ?
             WHERE id = ?
        `).run(
            trigger.name, trigger.keywords, trigger.match_type || 'contains',
            trigger.target_funnel_id, trigger.target_product_id || null,
            JSON.stringify(trigger.instances || []),
            trigger.active ? 1 : 0,
            trigger.id
        );
        return trigger.id;
    } else {
        const result = getDb().prepare(`
            INSERT INTO start_triggers (name, keywords, match_type, target_funnel_id, target_product_id, instances, active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            trigger.name, trigger.keywords, trigger.match_type || 'contains',
            trigger.target_funnel_id, trigger.target_product_id || null,
            JSON.stringify(trigger.instances || []),
            trigger.active === false ? 0 : 1
        );
        return result.lastInsertRowid;
    }
}

function deleteStartTrigger(id) {
    getDb().prepare('DELETE FROM start_triggers WHERE id = ?').run(id);
}

function toggleStartTrigger(id, active) {
    getDb().prepare('UPDATE start_triggers SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

// ⭐ FIX 11/05: registra cada disparo de start_trigger pra dashboard
function logStartTriggerFire(data) {
    try {
        getDb().prepare(
            `INSERT INTO start_trigger_log (trigger_id, trigger_name, phone_key, matched_keyword, instance, target_funnel_id)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
            data.trigger_id, data.trigger_name || null, data.phone_key,
            data.matched_keyword || null, data.instance || null, data.target_funnel_id || null
        );
    } catch(e) {}
}

// ⭐ FIX 11/05: stats de start_trigger pro dashboard
// Pra cada trigger: nome, keyword, disparos hoje, disparos total, leads que viraram PIX/venda
function getStartTriggerStats(targetDate) {
    if (!targetDate) {
        const now = new Date(Date.now() - 3 * 60 * 60 * 1000);
        targetDate = now.toISOString().split('T')[0];
    }
    try {
        // Lista todos os triggers (ativos + pausados) com contagem histórica
        const triggers = getDb().prepare(
            `SELECT id, name, keywords, match_type, active, triggered_count, last_triggered_at, target_funnel_id
             FROM start_triggers ORDER BY active DESC, id`
        ).all();
        if (!triggers.length) return { total_today: 0, converted_pix_today: 0, converted_sale_today: 0, revenue_today: 0, triggers: [] };

        // Pra cada trigger, conta disparos hoje + conversões
        const result = [];
        let totalToday = 0, convPixToday = 0, convSaleToday = 0, revenueToday = 0;
        for (const t of triggers) {
            const firesToday = getDb().prepare(
                `SELECT COUNT(*) as n FROM start_trigger_log
                 WHERE trigger_id = ? AND date(datetime(created_at, '-3 hours')) = ?`
            ).get(t.id, targetDate)?.n || 0;
            // Quantos leads desse trigger geraram PIX (em qualquer momento, mas trigger fire foi hoje)
            const convPix = getDb().prepare(
                `SELECT COUNT(DISTINCT l.phone_key) as n
                 FROM start_trigger_log l
                 INNER JOIN events e ON e.phone_key = l.phone_key
                 WHERE l.trigger_id = ?
                   AND date(datetime(l.created_at, '-3 hours')) = ?
                   AND e.type = 'PIX_GENERATED'
                   AND datetime(e.created_at) >= datetime(l.created_at)`
            ).get(t.id, targetDate)?.n || 0;
            // Quantos viraram venda
            const convSaleRow = getDb().prepare(
                `SELECT COUNT(DISTINCT l.phone_key) as n,
                        COALESCE(SUM(COALESCE(e.net_value, e.amount, 0)), 0) as rev
                 FROM start_trigger_log l
                 INNER JOIN events e ON e.phone_key = l.phone_key
                 WHERE l.trigger_id = ?
                   AND date(datetime(l.created_at, '-3 hours')) = ?
                   AND e.type IN ('PIX_PAID','CARD_PAID')
                   AND datetime(e.created_at) >= datetime(l.created_at)`
            ).get(t.id, targetDate);
            const convSale = convSaleRow?.n || 0;
            const revSale = Number(convSaleRow?.rev) || 0;

            result.push({
                id: t.id,
                name: t.name,
                keywords: t.keywords,
                match_type: t.match_type,
                active: !!t.active,
                triggered_count_total: t.triggered_count || 0,
                last_triggered_at: t.last_triggered_at,
                target_funnel_id: t.target_funnel_id,
                fires_today: firesToday,
                converted_pix_today: convPix,
                converted_sale_today: convSale,
                revenue_today: revSale,
                conv_rate_pix: firesToday > 0 ? +((convPix / firesToday) * 100).toFixed(1) : 0,
                conv_rate_sale: firesToday > 0 ? +((convSale / firesToday) * 100).toFixed(1) : 0
            });
            totalToday += firesToday;
            convPixToday += convPix;
            convSaleToday += convSale;
            revenueToday += revSale;
        }
        return {
            total_today: totalToday,
            converted_pix_today: convPixToday,
            converted_sale_today: convSaleToday,
            revenue_today: revenueToday,
            triggers: result
        };
    } catch(e) {
        return { total_today: 0, converted_pix_today: 0, converted_sale_today: 0, revenue_today: 0, triggers: [], error: e.message };
    }
}

function incrementStartTriggerCount(id) {
    try {
        getDb().prepare(`
            UPDATE start_triggers
               SET triggered_count = triggered_count + 1,
                   last_triggered_at = datetime('now')
             WHERE id = ?
        `).run(id);
    } catch(e) {}
}

// ===== FUNNEL ENABLED (toggle ativo/inativo) =====
function toggleFunnelEnabled(funnelId, enabled) {
    getDb().prepare('UPDATE funnels SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, funnelId);
}

// ===== WEBHOOK LOGS (auditoria + ROI por campanha) =====
function logWebhook(data) {
    try {
        getDb().prepare(`INSERT INTO webhook_logs
            (gateway, event, sale_id, phone_key, customer_email, customer_document,
             utm_source, utm_campaign, utm_medium, utm_content, utm_term,
             amount_gross, amount_net, payload_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            data.gateway || 'unknown',
            data.event || null,
            data.sale_id || null,
            data.phone_key || null,
            data.customer_email || null,
            data.customer_document || null,
            data.utm_source || null,
            data.utm_campaign || null,
            data.utm_medium || null,
            data.utm_content || null,
            data.utm_term || null,
            data.amount_gross || null,
            data.amount_net || null,
            data.payload_json || null
        );
    } catch(e) { console.error('Erro ao gravar webhook_log:', e.message); }
}
function cleanOldWebhookLogs(days = 90) {
    return getDb().prepare("DELETE FROM webhook_logs WHERE datetime(created_at) < datetime('now', '-' || ? || ' days')").run(days).changes;
}
// ===== RECONCILIAÇÃO HISTÓRICA (corrige net_value de vendas antigas) =====
function reconcileHistoricalNetValue(commissionPercent) {
    if (typeof commissionPercent !== 'number' || commissionPercent < 0 || commissionPercent > 100) {
        throw new Error('commissionPercent inválido (esperado 0-100)');
    }
    const factor = commissionPercent / 100;
    // Atualiza net_value para amount * fator nas vendas pagas (PIX_PAID, CARD_PAID)
    // ONDE net_value está zerado OU igual ao amount (ou seja, foi salvo como bruto)
    const result = getDb().prepare(`UPDATE events
        SET net_value = ROUND(amount * ?, 2)
        WHERE type IN ('PIX_PAID', 'CARD_PAID')
          AND amount > 0
          AND (net_value IS NULL OR net_value = 0 OR net_value = amount)`).run(factor);
    return { rowsUpdated: result.changes, factorApplied: factor };
}

// ===== FINANCEIRO (Painel novo) =====
function getFinanceDay(dateBR) {
    // Stats do dia (Brasília) com bruto e líquido
    const stats = getDb().prepare(`SELECT
        COUNT(CASE WHEN type='PIX_GENERATED' THEN 1 END) as pix_generated,
        COUNT(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN 1 END) as paid,
        COUNT(CASE WHEN type='PIX_PAID' THEN 1 END) as pix_paid,
        COUNT(CASE WHEN type='CARD_PAID' THEN 1 END) as card_paid,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(amount,0) ELSE 0 END) as gross,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as net
        FROM events WHERE date(datetime(created_at, '-3 hours')) = ?`).get(dateBR) || {};
    // ⭐ 22/07: potencial dos PIX gerados e NÃO pagos do dia ("se todos pagassem, quanto seria")
    // Dedup por telefone (mantém o maior valor) e exclui quem já pagou no dia.
    let pixPotential = 0;
    try {
        pixPotential = getDb().prepare(`SELECT COALESCE(SUM(mx), 0) as total FROM (
            SELECT MAX(COALESCE(amount, 0)) as mx FROM events
            WHERE type = 'PIX_GENERATED'
              AND date(datetime(created_at, '-3 hours')) = ?
              AND phone_key NOT IN (
                  SELECT DISTINCT phone_key FROM events
                  WHERE type IN ('PIX_PAID','CARD_PAID') AND date(datetime(created_at, '-3 hours')) = ?
              )
            GROUP BY phone_key
        )`).get(dateBR, dateBR).total || 0;
    } catch(e) {}
    return {
        date: dateBR,
        pix_generated: stats.pix_generated || 0,
        paid: stats.paid || 0,
        pix_paid: stats.pix_paid || 0,
        card_paid: stats.card_paid || 0,
        gross: stats.gross || 0,
        net: stats.net || 0,
        pix_potential: pixPotential
    };
}
function getFinanceMonth(year, month) {
    // year=2026, month=05 (string ou number)
    const m = String(month).padStart(2, '0');
    const startDate = `${year}-${m}-01`;
    const endDate = `${year}-${m}-31`;
    return getDb().prepare(`SELECT
        date(datetime(created_at, '-3 hours')) as date,
        COUNT(CASE WHEN type='PIX_GENERATED' THEN 1 END) as pix_generated,
        COUNT(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN 1 END) as paid,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(amount,0) ELSE 0 END) as gross,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as net
        FROM events
        WHERE date(datetime(created_at, '-3 hours')) BETWEEN ? AND ?
        GROUP BY date(datetime(created_at, '-3 hours'))
        ORDER BY date ASC`).all(startDate, endDate);
}
function getFinanceYear(year) {
    return getDb().prepare(`SELECT
        substr(date(datetime(created_at, '-3 hours')), 1, 7) as month,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(amount,0) ELSE 0 END) as gross,
        SUM(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN COALESCE(net_value,amount,0) ELSE 0 END) as net,
        COUNT(CASE WHEN type IN ('PIX_PAID','CARD_PAID') THEN 1 END) as paid
        FROM events
        WHERE substr(date(datetime(created_at, '-3 hours')), 1, 4) = ?
        GROUP BY substr(date(datetime(created_at, '-3 hours')), 1, 7)
        ORDER BY month ASC`).all(String(year));
}
// ===== PIX PAGES =====
function createPixPage(token, phoneKey, pixCode, customerName, amountDisplay, productName, expiresAt, productId, productsJson) {
    getDb().prepare(`INSERT OR REPLACE INTO pix_pages (token, phone_key, pix_code, customer_name, amount_display, product_name, expires_at, product_id, products_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(token, phoneKey, pixCode, customerName, amountDisplay, productName, expiresAt, productId || null, productsJson || null);
}
function getPixPage(token) {
    return getDb().prepare('SELECT * FROM pix_pages WHERE token = ?').get(token);
}
function cleanExpiredPixPages() {
    return getDb().prepare("DELETE FROM pix_pages WHERE expires_at < datetime('now')").run().changes;
}
function updateProductPixPage(productId, config) {
    getDb().prepare('UPDATE products SET pix_page_title=?, pix_page_model_name=?, pix_page_overlay_text=?, pix_page_media_url=? WHERE id=?')
        .run(config.title || null, config.model_name || null, config.overlay_text || null, config.media_url || null, productId);
}


module.exports = {
    initDatabase, getDb,
    getLocationFromPhone,
    getProducts, getActiveProducts, getProductByOfferId, saveProduct, toggleProduct, updateProductABFunnels,
    updateProductName, updateProductOffers, getProductOffers, getProductConversationCount, deleteProduct,
    updateFunnelName, updateFunnelMeta, getFunnelActiveConversationCount, deleteFunnel, createFunnel,
    getFunnels, getFunnelById, saveFunnel, recordABResult,
    getTriggers, saveTrigger, deleteTrigger,
    isBlacklisted, addToBlacklist, getBlacklist, removeFromBlacklist,
    getConversation, saveConversation, getConversations, getCompletedConversationsByPhone, deleteOldConversations,
    recordEvent, getEventStats, getTodayStats, getPeriodStats,
    logMessage, processWordFrequency, getTopWords,
    ensureInstance, getInstances, updateInstanceStats, getInstanceStats,
    setInstancePaused, setInstanceConnected, getFunnelDropoff,
    getSetting, setSetting, getAllSettings,
    logPhoneVariation, getWorkingVariation,
    updateInstanceHealth, getInstanceHealth,
    recordFunnelReceipt, getFunnelEffectiveness, hasReceivedFunnelRecently, cleanOldFunnelReceipts, clearFunnelReceiptOnPayment, getFunnelTypeBreakdown,
    hasEverPaid, scheduleFunnel, getPendingScheduledFunnels, markScheduledFunnelFired, cancelScheduledFunnel, cancelScheduledFunnelsByPhone, getRecoveryStats,
    getAbandonoInstances, setInstanceAbandono,
    updateInstanceIdentity, getInstanceIdentity,
    savePixTimeout, deletePixTimeout, getAllPendingPixTimeouts, cleanExpiredPixTimeouts,
    upsertPhoneNumber, updatePhoneIdentity, getPhoneNumber, getAllPhoneNumbers, getPhoneNumberByInstance,
    recordPhoneDrop, recordPhoneRecovery, reclassifyDrop,
    getPhoneDrops, getAllPhoneDrops,
    incrementPhoneMessages, getPhoneMessageStats, getPhoneSummary,
    getStartTriggers, getActiveStartTriggers, saveStartTrigger, deleteStartTrigger, toggleStartTrigger, incrementStartTriggerCount, logStartTriggerFire, getStartTriggerStats,
    toggleFunnelEnabled,
    createPixPage, getPixPage, cleanExpiredPixPages, updateProductPixPage,
    logWebhook, cleanOldWebhookLogs,
    reconcileHistoricalNetValue,
    getFinanceDay, getFinanceMonth, getFinanceYear
};
