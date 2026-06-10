# Orion — Automação de Vendas no WhatsApp

Sistema de conversão e acompanhamento de vendas: recebe os eventos da Kirvano (PIX gerado, pagamento aprovado, carrinho abandonado, cartão recusado), dispara funis de mensagem no WhatsApp via Evolution API e notifica tudo no app do celular (PWA).

## Como funciona

1. Cliente gera um PIX no checkout → webhook chega no Orion → push "PIX Gerado" no celular.
2. O sistema espera 7 minutos (configurável). Se o cliente não pagar, dispara o funil de cobrança.
3. Se o cliente pagar (antes ou depois do funil começar), o funil de cobrança é cancelado na hora e o funil de VENDA APROVADA envia o acesso.
4. Carrinho abandonado e cartão recusado têm funis próprios, com pool de instâncias isolado.
5. Recuperação opcional 24h depois para quem não comprou.

## Arquivos

| Arquivo | O que é |
|---|---|
| `server.js` | Servidor completo (webhooks, funis, instâncias, push, API) |
| `database.js` | Banco SQLite (better-sqlite3) — tabelas e consultas |
| `public/index.html` | Painel completo (desktop) — funis, gatilhos, produtos, financeiro |
| `public/mobile.html` | App do celular (PWA) — dashboard, instâncias, análises, ajustes |
| `public/sw.js` | Service worker — recebe os pushes |

## Variáveis de ambiente (EasyPanel)

Obrigatórias:

- `JWT_SECRET` — segredo do login (mínimo 32 caracteres)
- `ADMIN_LOGIN` e `ADMIN_PASSWORD` (ou `ADMIN_PASSWORD_HASH`)
- `EVOLUTION_API_URL` e `EVOLUTION_API_KEY` — sua Evolution API
- `VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY` — chaves do push (gere com `npx web-push generate-vapid-keys`)
- `APP_URL` — URL pública do app (usada nos links de PIX)

Opcionais:

- `PIX_TIMEOUT_MS` — espera antes do funil de PIX (padrão 7 min)
- `KIRVANO_WEBHOOK_SECRET` — valida assinatura dos webhooks
- `META_ACCESS_TOKEN` + `META_AD_ACCOUNTS` (e `_BM2`...`_BM20`) — puxa gasto do Facebook automaticamente; sem isso, o gasto é digitado manualmente pelo app (recomendado)
- `NOTIFICATION_INSTANCE` — nome de uma instância pessoal que NUNCA entra no pool de envio

## Notificações (push do app)

Apenas eventos de venda — sem avisos de instância:

- PIX gerado · Pagamento aprovado · Carrinho abandonado · Cartão recusado
- Resumo da manhã (9h) e fechamento do dia (23:59)

Cada tipo pode ser ligado/desligado em **Ajustes** (ícone de engrenagem no app).

## Instâncias

- Verificação silenciosa a cada 5 minutos (só atualiza o status na tela e retoma leads travados).
- Quando um envio falha, a instância é verificada na hora e o envio cai para a próxima do pool.
- Cada lead fica fixo na instância que o atendeu (sticky), com tolerância de 3 dias se ela cair.

## Deploy

Suba este repositório no GitHub e aponte o EasyPanel para ele (o `Dockerfile` cuida do resto). O banco fica em `data/orion.db` — use um volume persistente para não perder os dados entre deploys.
