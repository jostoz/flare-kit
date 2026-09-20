# Documento de Requerimientos Técnicos (TRD) — v2

**Proyecto:** Cloudflare-Kit (flare-kit)
**Tipo:** Boilerplate full-stack serverless para Micro-SaaS
**Objetivo:** Operar un Micro-SaaS a **$0 USD/mes de infraestructura** dentro del Free Tier de Cloudflare, con aprovisionamiento 100% declarativo vía REST API (agent-ready, sin panel web).
**Fecha de validación de límites:** 2026-09-20

---

## 0. Cambios respecto a v1 (y por qué)

| # | v1 | v2 | Razón |
|---|----|----|-------|
| 1 | Sesiones en KV | Sesiones en **D1** + cookie firmada; KV solo lectura-caché | KV free = **1,000 escrituras/día**. 1 login = 1 escritura → techo de ~1k logins/día. Rompe el objetivo. |
| 2 | Rate limit en KV | **Rate Limiting API** (binding nativo, gratis) + contadores de cuota en D1 | Mismo límite de escrituras; además KV impone 1 escritura/seg por clave. |
| 3 | D1 "500 MB" | **5 GB**; límites diarios ahora **devuelven error** (enforcement desde 2026-09-01) | Dato desactualizado. El diseño debe tener modo degradado, no crash. |
| 4 | "TTFB < 50 ms global" | TTFB < 50 ms **solo en rutas cacheadas en edge**; rutas con D1 ≤ 200 ms p75 | D1 tiene región primaria; un SSR con query cruzando el Atlántico no baja de ~120 ms. |
| 5 | Sin presupuesto de CPU | **10 ms CPU/request** es la restricción crítica | El free plan mata el request al excederlo (error 1102). Medido: el SSR de React **no** es el culpable (§3.1.1); lo son el hashing de contraseñas y los adapters tipo Next/OpenNext. |
| 6 | "100k peticiones/día" | 100k **requests dinámicos**; assets estáticos no cuentan | Cambia por completo el cálculo de MAU soportados. |
| 7 | TanStack Start *o* Hono | **TanStack Start es el default** (SSR), Hono como preset `--preset=api` | Decisión tomada, no diferida. Benchmark local: 51 KB de HTML = 1.57 ms p50 / 2.84 ms p99. Cabe en 10 ms con margen. Lo prohibido es Next.js/OpenNext. |
| 8 | `cf.createD1Database` | Endpoints REST explícitos y documentados | Esa API no existe; el bootstrap debe ser implementable tal cual está escrito. |
| 9 | Árbol de repo inconsistente | Rutas únicas y canónicas | v1 decía `/drizzle/migrations` en §3.2, `src/db/migrations` en §4, y `bootstrap.ts` vs `setup-mcp.ts`. |
| 10 | Sin criterio verificable | Gate automatizado `pnpm run budget:check` | "Debe tolerar 5,000 MAU" no es testeable sin un modelo de consumo ejecutable. |

---

## 1. Arquitectura

```
[ Cliente ]
     │
     ├──> [ Workers Static Assets ]  ── HTML/JS/CSS/img — GRATIS, ILIMITADO, no cuenta requests
     │
     ▼
[ Cloudflare Worker ]  (TanStack Start SSR + Hono en /api)
     │  presupuesto: 10 ms CPU, 50 subrequests, 128 MB RAM
     │
     ├──> [ D1 ]         Datos relacionales, usuarios, SESIONES, cuotas
     ├──> [ KV ]         SOLO lectura: config, feature flags, caché de respuestas públicas
     ├──> [ R2 ]         Archivos de usuario (presigned uploads directos desde el cliente)
     ├──> [ Rate Limit ] Binding nativo, sin costo, sin escrituras
     ├──> [ Workers AI ] Inferencia, con cuota por usuario contabilizada en D1
     └──> [ Cache API ]  Caché de edge por colo — primera línea, coste cero
```

**Regla de oro del kit:** todo request que puede resolverse en Static Assets o Cache API **no debe llegar al Worker**. El Worker es el recurso escaso.

---

## 2. Presupuesto del Free Tier (verificado 2026-09-20)

Todos los contadores resetean a las **00:00 UTC** y, al excederse, las operaciones **fallan con error** (no hay degradación silenciosa ni cobro automático).

| Servicio | Límite free | Restricción real para este kit |
|---|---|---|
| Workers — requests | 100,000 / día | Solo requests al Worker. Assets estáticos: ilimitados y gratis. |
| Workers — CPU | **10 ms / request** | **Cuello de botella #1.** SSR de React ≈ 5–40 ms según árbol. |
| Workers — subrequests | 50 / invocación | Limita fan-out a Stripe + AI + R2 en un mismo request. |
| Workers — memoria | 128 MB | — |
| Workers — tamaño script | 3 MB gzip (límite elevado a 64 MiB en planes pagos) | Objetivo del kit: < 1 MB. |
| D1 — lecturas | 5,000,000 filas leídas / día | "Filas leídas" = filas **escaneadas**, no devueltas. Sin índice, un `WHERE` es un full scan. |
| D1 — escrituras | 100,000 filas escritas / día | Cada índice secundario suma 1 fila escrita por INSERT. |
| D1 — almacenamiento | **5 GB** (cuenta completa) | Al tope: fallan INSERT, DDL y creación de índices. |
| KV — lecturas | 100,000 / día | Usable. |
| KV — escrituras | **1,000 / día** | **Prohibido** para sesiones, rate limits o cualquier dato por-usuario. |
| R2 — almacenamiento | 10 GB-mes | — |
| R2 — Clase A (write/list) | 1,000,000 / mes | — |
| R2 — Clase B (read) | 10,000,000 / mes | Egress siempre $0. |
| Workers AI | 10,000 Neurons / día, pool compartido entre modelos | Modelos grandes vacían el pool en minutos. |
| Cron Triggers | Incluido | Usado para compactación y reset de cuotas. |

### 2.1 Modelo de consumo — objetivo 5,000 MAU

Supuestos declarados y versionados en `budget.config.ts`:

```
5,000 MAU × 20 sesiones/mes × 8 requests dinámicos/sesión = 800,000 req/mes ≈ 26,700 req/día
```

Presupuesto derivado **por request dinámico** (con 25% de margen sobre el pico diario de 33,000):

| Recurso | Presupuesto por request | Total diario |
|---|---|---|
| CPU | **≤ 7 ms** (p99; 3 ms de margen) | — |
| Filas leídas D1 | **≤ 100** | 3.3 M / 5 M |
| Filas escritas D1 | **≤ 2** | 66 k / 100 k |
| Lecturas KV | **≤ 2** | 66 k / 100 k |
| Escrituras KV | **0** (solo deploy/cron) | < 50 / 1,000 |
| Subrequests | ≤ 5 | — |

Cualquier ruta nueva que exceda estos números debe justificarlo en su PR o fallar el gate de §7.

### 2.2 Costos que NO son $0 (declarados explícitamente)

- **Stripe:** comisión por transacción. Ajeno a Cloudflare.
- **Dominio propio:** costo del registro. Zona Cloudflare y Workers Custom Domain sí son gratis.
- **Email transaccional:** Resend free = 3,000/mes y **100/día** → techo de 100 magic links/día. Documentado como límite del kit.
- Si se excede cualquier cuota, el plan free **no cobra**: devuelve error. El objetivo de $0 es estructural.

---

## 3. Módulos core

### 3.1 Framework y router

- **Default: TanStack Start** (SSR sobre Workers) + **Drizzle** + **Hono** como router de `/api`. Bundle objetivo < 1 MB gzip, cold start < 5 ms.
- **Preset `--preset=api`:** solo Hono, sin React, para backends puros.
- **Prohibido en el kit:** Next.js vía OpenNext/next-on-pages. Su overhead de runtime (router + RSC + module init) es la causa documentada de los 1102 en free tier, y existe un bug abierto de acumulación de estado por isolate que mata el Worker tras ~120 renders.
- **Assets:** bloque `assets` de Wrangler. Los estáticos nunca invocan el Worker ni consumen cuota.
- **Streaming SSR no reduce CPU**, solo TTFB. Sirve para percepción, no para el límite de 10 ms.

#### 3.1.1 Evidencia: el SSR de React cabe en 10 ms

Medición local (React 19 `renderToString`, i7-12700K, 100 iteraciones tras warmup):

| Filas | HTML | p50 | p99 |
|---|---|---|---|
| 25 | 5 KB | 0.23 ms | 1.83 ms |
| 50 | 10 KB | 0.37 ms | 2.20 ms |
| 100 | 20 KB | 0.65 ms | 1.51 ms |
| 250 | 51 KB | 1.57 ms | 2.84 ms |

Incluso aplicando un factor 3× por el isolate de workerd (sin JIT caliente), una página de 51 KB queda en ~8.5 ms p99 en el peor caso, y en ~5 ms para páginas realistas de 20 KB. **El render no es el cuello de botella.**

#### 3.1.2 Lo que sí excede 10 ms de CPU (lista de prohibiciones)

| Causa | Costo CPU | Regla del kit |
|---|---|---|
| bcrypt / argon2 / scrypt en JS | 50–300 ms | **Prohibido.** Ver §3.3. |
| Adapters Next.js (OpenNext) | 10–20 ms + fugas por isolate | Prohibido. |
| `JSON.parse` de payloads > 1 MB | 10 ms+ | Límite de body a 256 KB en `/api`. |
| Module init en el primer request del isolate | Cuenta como CPU de ese request | Imports dinámicos para Stripe/AI; nada pesado en top-level. |
| Renderizar listas sin paginar | Lineal en filas | Paginación obligatoria, tope 100 filas por vista. |
| Criptografía en loop (no WebCrypto) | Alto | Todo hashing/firma vía `crypto.subtle` (nativo, no cuenta como JS). |

### 3.2 Base de datos

- **D1** + **Drizzle ORM**. Migraciones SQL versionadas en **`drizzle/migrations/`** (ruta única y canónica; `src/db/` contiene solo `schema.ts` y el cliente).
- Reglas obligatorias de esquema:
  - Índice explícito para toda columna usada en `WHERE`, `JOIN` u `ORDER BY`. Sin esto, "filas leídas" explota.
  - `PRAGMA`/`EXPLAIN QUERY PLAN` ejecutado en CI sobre las queries del kit; cualquier `SCAN TABLE` sin índice falla el build.
  - Índices mínimos necesarios: cada índice extra = +1 fila escrita por INSERT.
- **Read replication (Sessions API)** habilitada por defecto para lecturas globales; el token de sesión de D1 se propaga en cookie para garantizar read-your-writes.
- Seeds vía `drizzle-kit` en local; en remoto vía el endpoint de query del bootstrap (§5).

### 3.3 Autenticación

- **Better Auth**, adaptador Drizzle/D1.
- **Sesiones en D1**, no en KV. Lookup por `session.id` indexado = 1 fila leída.
- Cookie `HttpOnly; Secure; SameSite=Lax` firmada con `AUTH_SECRET`; el payload lleva `userId` y `exp` para evitar el hit a D1 en rutas que no requieren revocación inmediata.
- Rotación de sesión: máximo 1 escritura por login, no por request (`updatedAt` con granularidad de 24 h).
- Métodos: Magic Link (Resend, tope 100/día documentado) + OAuth Google/GitHub.
- **Contraseñas: prohibido bcrypt/argon2/scrypt en JS** (50–300 ms de CPU = error 1102 garantizado en free). Si se habilita login por password, el hash es **PBKDF2-SHA256 vía `crypto.subtle`** (nativo, no cuenta como tiempo de JS). Rutas primarias recomendadas: OAuth y Magic Link, que no hashean nada.
- Limpieza de sesiones expiradas: Cron Trigger diario, `DELETE ... WHERE expiresAt < now LIMIT 1000` (acotado para no vaciar el presupuesto de escrituras).

### 3.4 Pagos

- **Stripe Checkout + Webhooks.**
- `POST /api/stripe/checkout` — crea sesión, 1 subrequest.
- `POST /api/stripe/webhook` — verificación de firma con `Stripe.webhooks.constructEventAsync` (**obligatorio**: la variante síncrona usa crypto de Node y falla en Workers).
- **Idempotencia:** tabla `stripe_events(id PRIMARY KEY, processedAt)`. `INSERT OR IGNORE` antes de procesar; evita doble aplicación en reintentos de Stripe.
- El endpoint responde `200` antes de trabajo pesado; lo diferible va a `ctx.waitUntil`.
- Mapeo `stripe_customer_id` ↔ `user.id` con índice único.

### 3.5 Workers AI

- Modelo por defecto: `@cf/meta/llama-3.1-8b-instruct`.
- **Cuota por usuario obligatoria:** contador diario en D1 (`ai_usage(userId, day, neurons)`), verificado antes de invocar. Sin esto, un solo usuario agota los 10,000 Neurons compartidos de la cuenta.
- El consumo real se reconcilia contra la GraphQL Analytics API mediante Cron Trigger diario; los costes por Neuron del modelo se calibran ahí, no se hardcodean.
- Al agotarse el pool: respuesta `429` con mensaje explícito, nunca un error opaco.

### 3.6 Almacenamiento

- **R2** con **uploads directos desde el cliente** vía URL presignada (`POST /api/r2/sign`). El archivo nunca atraviesa el Worker → no consume CPU ni memoria.
- Compresión/redimensionado en cliente (`createImageBitmap` + canvas) antes de subir.
- Lecturas públicas vía dominio R2 público o Worker con `Cache-Control` largo.

### 3.7 Resiliencia ante agotamiento de cuota

Requerimiento nuevo y no negociable, dado el enforcement de D1 desde 2026-09-01:

- Wrapper único de acceso a datos que captura errores de límite excedido y devuelve un modo **read-only degradado** (banner en UI, escrituras rechazadas con `503` y mensaje claro), en lugar de un 500 genérico.
- Métricas de consumo diario expuestas en `GET /api/_health/budget` (protegido).

---

## 4. Estructura del repositorio

```
flare-kit/
├── .github/workflows/
│   ├── deploy.yml              # wrangler deploy
│   └── budget-check.yml        # gate de §7, bloqueante en PR
├── src/
│   ├── index.ts                # entry Hono
│   ├── app/                    # UI (SPA por defecto; SSR si preset TanStack)
│   ├── db/
│   │   ├── schema.ts
│   │   └── client.ts           # D1 + Sessions API
│   ├── server/
│   │   ├── auth.ts
│   │   ├── stripe.ts
│   │   ├── ai.ts
│   │   ├── r2.ts
│   │   └── quota.ts            # wrapper de límites + modo degradado
│   └── lib/cf/                 # cliente tipado de la REST API de Cloudflare
├── drizzle/migrations/         # ÚNICA ubicación de migraciones SQL
├── scripts/
│   ├── bootstrap.ts            # aprovisionamiento por API (§5)
│   ├── teardown.ts             # destrucción idempotente de los recursos creados
│   └── budget-check.ts         # gate de presupuesto (§7)
├── budget.config.ts            # supuestos de consumo, versionados
├── wrangler.jsonc
├── drizzle.config.ts
└── package.json
```

---

## 5. Aprovisionamiento por API (`scripts/bootstrap.ts`)

**Requisito:** `bootstrap({ apiToken })` deja la app en producción sin ninguna interacción con el panel.

### 5.1 Scopes exigidos al token

Validados al inicio; si falta alguno, aborta con la lista exacta:

```
Account: Workers Scripts:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit,
         D1:Edit, Workers AI:Edit, Account Settings:Read
```

### 5.2 Secuencia (todos los pasos idempotentes)

| Paso | Endpoint REST |
|---|---|
| 1. Verificar token | `GET /client/v4/user/tokens/verify` |
| 2. Account ID | `GET /client/v4/accounts` |
| 3. Crear D1 | `POST /client/v4/accounts/{account_id}/d1/database` |
| 4. Crear KV | `POST /client/v4/accounts/{account_id}/storage/kv/namespaces` |
| 5. Crear R2 | `POST /client/v4/accounts/{account_id}/r2/buckets` |
| 6. Migrar | `POST /client/v4/accounts/{account_id}/d1/database/{id}/query` por archivo de `drizzle/migrations/`, registrando en tabla `__migrations` |
| 7. Secretos | incluidos como bindings `secret_text` en el metadata del upload |
| 8. Desplegar Worker | `PUT /client/v4/accounts/{account_id}/workers/scripts/{name}` (multipart: `metadata` + módulos + assets) |
| 9. Habilitar subdominio | `POST /client/v4/accounts/{account_id}/workers/scripts/{name}/subdomain` |
| 10. Devolver URL | `https://{name}.{subdomain}.workers.dev` + healthcheck |

### 5.3 Requerimientos no funcionales del bootstrap

- **Idempotencia:** recurso ya existente → reutilizar, nunca duplicar ni fallar. `bootstrap()` dos veces = mismo estado.
- **Persistencia de IDs:** escribe los IDs reales en `wrangler.jsonc` y en `.flare-kit.state.json`.
- **Rollback:** fallo después del paso 3 → `teardown.ts` revierte lo creado en esa corrida.
- **Sin secretos en logs.** El token nunca se imprime ni se persiste en disco.
- **Salida estructurada** (`JSON` en stdout) para consumo por agentes.

---

## 6. `wrangler.jsonc` de referencia

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "flare-kit-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,

  // Estáticos: gratis, ilimitados, NO cuentan como request de Worker
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },

  "observability": { "enabled": true },

  "d1_databases": [
    { "binding": "DB", "database_name": "flare-kit-db", "database_id": "REPLACE_WITH_D1_ID" }
  ],

  // SOLO lectura-caché. Prohibido escribir por-request (1,000 escrituras/día)
  "kv_namespaces": [
    { "binding": "CONFIG_KV", "id": "REPLACE_WITH_KV_ID" }
  ],

  "r2_buckets": [
    { "binding": "ASSETS_BUCKET", "bucket_name": "flare-kit-assets" }
  ],

  "ai": { "binding": "AI" },

  // Rate limiting sin costo ni escrituras
  "ratelimits": [
    { "name": "API_LIMITER", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }
  ],

  "triggers": { "crons": ["0 3 * * *"] },

  "vars": { "APP_ENV": "production" }
}
```

Secretos (nunca en `vars`): `AUTH_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_SECRET`.

---

## 7. Criterios de aceptación (verificables, automatizados)

Cada criterio es un comando que pasa o falla. Sin métricas cualitativas.

### 7.1 Presupuesto de CPU — `pnpm run budget:cpu`
Dos capas, implementadas: (a) `test/budget.cpu.test.tsx` — trip-wire de regresión gruesa en cada PR (< 30 ms, tolerante al ~4× de overhead medido del propio runner de vitest frente a `bun`/`node` puro); (b) gate autoritativo: ejecutar las rutas de referencia bajo `wrangler dev --remote` y leer `cpuTime` real de los logs de observabilidad (incluye el primer request del isolate, donde cuenta el module init).
**Pasa si:** (a) sin fallos en CI, y (b) p99 ≤ 7 ms en `wrangler dev --remote` antes de cada release.
No es un gate sobre "si el SSR entra": el SSR entra (§3.1.1, medido: 51 KB de HTML = 2.84 ms p99 bajo `bun` directo). Es el guardián contra las regresiones de §3.1.2 — una dependencia pesada en top-level, un hash en JS o una lista sin paginar.

### 7.2 Presupuesto de datos — `bun run budget:check`
**Implementado y verificado** (`scripts/budget-check.ts`): proyecta `PER_REQUEST_BUDGET` × `projectedDynamicRequestsPerDay` (ambos en `budget.config.ts`) contra cada cuota de `FREE_TIER_LIMITS`.
**Pasa si:** cada recurso queda ≤ 80% de su cuota diaria. Verificado: 66.7% D1 lecturas/escrituras, 66.7% KV lecturas, 0% KV escrituras, 33.3% requests — todos dentro del margen.
Es una proyección estática desde los supuestos declarados, no instrumentación en vivo de un flujo E2E contra D1 real (eso requiere una cuenta Cloudflare desplegada; queda como extensión de este mismo script una vez en producción, leyendo `meta.rows_read`/`meta.rows_written` reales de las respuestas D1).

### 7.3 Deploy de un comando — `bun run deploy`
**Implementado** (`scripts/bootstrap.ts` + `src/lib/cf/client.ts`): valida token, resuelve cuenta, crea D1/KV/R2 idempotentemente, aplica migraciones vía REST, despliega el Worker y habilita el subdominio.
**Verificado sin cuenta Cloudflare real:** `wrangler deploy --dry-run` compila el Worker limpio con los 7 bindings declarados (D1, KV, R2, AI, Rate Limit, Assets, var). El roundtrip contra la API real (`CLOUDFLARE_API_TOKEN` válido) no se ha ejecutado en este entorno — pendiente de verificación con credenciales.
**Pasa si:** desde un repo limpio y solo `CLOUDFLARE_API_TOKEN`, devuelve una URL `*.workers.dev` que responde `200` en `/api/_health`, y una segunda ejecución produce el mismo estado sin errores (idempotencia).

### 7.4 Latencia — `bun run bench:ttfb`
Medida desde ≥ 5 regiones:
- Rutas estáticas / cacheadas en edge: **TTFB p75 < 50 ms**.
- Rutas dinámicas con D1 (con read replication): **TTFB p75 < 200 ms**.
El "< 50 ms global con SSR+DB" de v1 es físicamente inalcanzable y queda retirado. No implementado: requiere despliegue real multi-región.

### 7.5 Degradación — `bun run test test/quota.test.ts`
**Implementado y verificado** (`src/server/quota.ts`, `test/quota.test.ts`, 3/3 tests en verde): con D1 en estado de cuota excedida, `withQuotaGuard` convierte el error opaco de Cloudflare en `QuotaExceededError`, y `degradedResponse` devuelve `503` con cuerpo estructurado. **Nunca** un 500 sin contexto.

### 7.6 Tamaño del bundle — `bun run size`
**Pasa si:** worker ≤ 1 MB gzip.
**Verificado:** `wrangler deploy --dry-run` mide 3.3 MB sin comprimir / **600 KB gzip** para el bundle completo (Hono + Better Auth + Drizzle + Stripe + React SSR). Dentro del presupuesto con margen.

---

## 8. Riesgos abiertos

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| Regresión de CPU por dependencia pesada o hash en JS | Media | Gate 7.1 en cada PR + lista de prohibiciones §3.1.2. |
| Module init del isolate frío empuja el primer request sobre 10 ms | Media | Imports dinámicos; el gate 7.1 mide explícitamente el request frío. |
| Un usuario agota 10k Neurons de la cuenta | Alta sin cuota | Contador por usuario en D1 (§3.5). |
| Queries sin índice agotan 5M filas leídas | Media | `EXPLAIN QUERY PLAN` en CI. |
| 100 emails/día de Resend limitan signups | Media | Documentado; OAuth como ruta primaria. |
| Cambios de límites del free tier por Cloudflare | Media | `budget.config.ts` centralizado + revisión trimestral fechada. |
