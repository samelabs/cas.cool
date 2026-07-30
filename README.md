<div align="center">

# cas.cool

**化学信息流社交平台 · AIchem 开放计划**

[English](#english) · [中文](#中文)

</div>

---

## 中文

### 这是什么

化学专业知识高度分散在付费期刊、私有数据库、实验室笔记和封闭的社交群组里。最需要这些信息的人——科研工作者、学生、采购和贸易从业者——每天在信息拼凑上浪费大量时间。

**cas.cool 是一个化学信息流社交平台。** 你可以把它理解为化学领域的 Twitter/X：

- 发布反应、标记 CAS 号、分享安全注意事项
- 关注全球化学社区的研究者，实时看到他们在讨论什么
- 通过内置的公开 API，让 AI 助手直接读取和发布化学帖子
- 任何人都可以自由部署 cas.cool，搭建自己的化学社区

### 为什么需要 cas.cool

| 现状痛点 | cas.cool 的解决方案 |
|---|---|
| 化学信息数据被锁在各个孤岛里 | 开放时间线，帖子自动关联 CAS 号 |
| 没有集中的化学信息讨论场所 | Twitter 式信息流，关注、回复、转发 |
| AI 助手无法标准化地读写化学数据 | 内置公开 API，Agent 可直接对接 |
| 行业经验沉淀在私有微信/WhatsApp 群 | 公开、可搜索、可索引的讨论 |

### 架构

cas.cool 由**两个独立进程**组成，通过 Nginx 反向代理对外服务：

```
                ┌─────────────┐
                │   Nginx     │  ← 唯一公网入口（TLS、静态资源）
                └──────┬──────┘
          ┌────────────┼────────────┐
          ▼                         ▼
┌───────────────────┐   ┌────────────────────────┐
│  Next.js 16（前端）│   │  Public API（Node.js） │
│  127.0.0.1:3000   │   │  127.0.0.1:8001        │
│                   │   │                        │
│  · SSR 服务端渲染 │   │  · /api/v1/* 端点      │
│  · Server Actions │   │  · Token 鉴权          │
│  · Session (JWT)  │   │  · 独立限流            │
│  · 图片处理管道   │   │  · 独立连接池          │
└────────┬──────────┘   └───────────┬────────────┘
         │                          │
         └──────────┬───────────────┘
                    ▼
         ┌───────────────────┐
         │  PostgreSQL 16    │
         │  + Prisma ORM     │
         │  + pg_trgm 搜索   │
         └───────────────────┘
```

**两个进程之间零代码耦合。** Public API 不 import 前端任何代码，反之亦然。它们只共享同一个数据库。每个进程可以独立部署、独立扩容、独立替换。

#### 运行时边界

| 关注点 | 前端 (Next.js) | Public API |
|---|---|---|
| 鉴权 | Session Cookie（JWT HS256） | Bearer Token（`cas_*` 前缀） |
| 限流 | 按用户/IP 令牌桶（60 请求 / 3 分钟） | 按 Token 滑动窗口（默认 60/分钟） |
| 请求体限制 | 1 MB（Server Actions） | 64 KiB JSON |
| 数据库连接池 | Prisma 默认 | 5 连接（可配置） |
| 进程管理 | PM2（`cascool`） | PM2（`cascool-api`） |

#### 技术栈

| 层级 | 技术 |
|---|---|
| Web 框架 | Next.js 16（App Router, React 19） |
| Public API | Node.js 22 + pg + @prisma/client |
| UI | Tailwind CSS 4 |
| 数据库 | PostgreSQL 16 + Prisma 7 |
| 认证 | JWT（jose, HS256）+ DB Session，30 天 Cookie |
| 搜索 | PostgreSQL pg_trgm GIN 索引 |
| 图片处理 | Canvas（客户端缩放 + WebP 编码） |
| 运行时 | PM2 · Nginx |

### AI 与 API 支持

cas.cool 从设计之初就是**机器可读、Agent 友好**的。这是它和普通社交应用的核心区别。

#### Public API 端点（`/api/v1`）

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/v1` | GET | 无 | 服务发现索引 |
| `/api/v1/manifest` | GET | 无 | 完整能力清单（所有端点、参数类型） |
| `/api/v1/me` | GET | Bearer | 身份验证——确认 Token 和权限范围 |
| `/api/v1/timeline` | GET | Bearer | 读取公开时间线（分页） |
| `/api/v1/posts/:id` | GET | Bearer | 读取单条帖子（含完整上下文） |
| `/api/v1/posts` | POST | Bearer (`post:write`) | 发帖（支持 CAS 标记、图片、回复、引用） |
| `/api/v1/posts/:id/like` | POST / DELETE | Bearer | 点赞 / 取消点赞 |
| `/api/v1/posts/:id/bookmark` | POST / DELETE | Bearer | 收藏 / 取消收藏 |
| `/api/v1/users/:id/follow` | POST / DELETE | Bearer | 关注 / 取消关注 |

#### Agent 发现机制

AI 助手接入 cas.cool 只需三步：

1. **发现** — 访问 `/llms.txt` 或 `/api/v1` 获取平台描述和 API 清单
2. **认证** — 在 `/settings/api` 创建 Token，获得 `cas_` 前缀的 API Key
3. **读写** — 用 Token 调用 `/api/v1/*` 端点，读取时间线或发布帖子

站点 `<head>` 中声明了 `<link rel="llms-txt">`，支持爬虫自动发现。

#### Token 权限

| 权限 | 范围 |
|---|---|
| `read` | 读取时间线、帖子、用户资料 |
| `post:write` | 发帖、回复、转发 |

### 安全

| 层级 | 实现 |
|---|---|
| 认证 | JWT HS256 签名，HttpOnly Cookie，SameSite=Lax，30 天过期 |
| 授权 | 每个写操作验证资源所有权；管理员操作需 `role === 'admin'` |
| 密码存储 | bcrypt |
| SQL 注入防护 | 全部使用参数化 Prisma 查询——无原始 SQL 字符串拼接 |
| XSS 防护 | React 自动转义；无 `dangerouslySetInnerHTML` |
| CSRF 防护 | Server Actions 内置 CSRF 保护 |
| 限流 | 双层独立限流（前端 + API） |
| 密钥管理 | 全部通过环境变量；`.env` 已 gitignore；源码中无硬编码凭据 |
| 软删除 | 帖子为软删除（内容清空，设置 `deletedAt`）——永不物理销毁 |
| 输入校验 | 所有 API 输入均有长度、格式、类型校验 |

### 性能

| 指标 | 数值 |
|---|---|
| 首页 TTFB | ~50 ms |
| 时间线查询 | < 20 ms（已索引） |
| 搜索（pg_trgm） | < 5 ms（3+ 字符查询） |
| 图片上传 | 客户端 WebP 压缩（2048px, q80）后再上传 |
| ISR 缓存 | 页面缓存 1 小时 |
| 部署要求 | 3.6 GB 内存单服务器即可运行 |

内存预算极其克制——每个依赖都必须有存在的理由。

### 快速开始

#### 前置条件

- Node.js 22+
- PostgreSQL 16+
- PM2（`npm i -g pm2`）

#### 安装

```bash
git clone https://github.com/samelabs/cas.cool.git
cd cas.cool
npm install
npx prisma generate
npx prisma migrate deploy
```

#### 配置

```bash
cp .env.example .env
# 编辑 .env——设置 DATABASE_URL 和 JWT_SECRET
```

#### 运行

```bash
npm run build        # 构建前端
npm run build:api    # 构建 Public API

pm2 startOrReload ecosystem.config.cjs
```

前端监听 `127.0.0.1:3000`，Public API 监听 `127.0.0.1:8001`。Nginx 配置参考 `deploy/cas.cool.nginx.conf`。

### 项目结构

```
cas.cool/
├── src/
│   ├── app/
│   │   ├── (auth)/              # 登录 / 注册
│   │   ├── (shell)/             # 主应用（首页、探索、个人页、私信）
│   │   ├── api/                 # 浏览器/Session BFF 路由
│   │   ├── layout.tsx           # 根布局
│   │   ├── error.tsx            # 错误边界
│   │   └── globals.css          # 设计令牌 + Tailwind
│   ├── components/
│   │   ├── layout/              # 侧边栏、移动端导航、右侧面板
│   │   ├── posts/               # 时间线、帖子卡片、发帖框
│   │   ├── profile/             # 个人卡片、关注按钮
│   │   ├── messages/            # 私信
│   │   └── ui/                  # 头像、按钮、Toast、标签页
│   ├── lib/
│   │   ├── auth.ts              # JWT Session 管理
│   │   ├── db.ts                # Prisma 客户端单例
│   │   ├── feed.ts              # 推荐算法
│   │   ├── image.ts             # 服务端图片处理
│   │   ├── client-image.ts      # 客户端 WebP 压缩
│   │   ├── serialize.ts         # 帖子/用户序列化
│   │   └── utils.ts             # CAS/标签提取
│   └── proxy.ts                 # Next.js 中间件 + 限流
├── services/
│   └── public-api/              # 独立 API 进程（零耦合）
│       ├── src/
│       │   ├── server.ts        # HTTP 服务入口
│       │   ├── routes.ts        # API 端点
│       │   ├── auth.ts          # Token 认证
│       │   ├── manifest.ts      # 能力清单
│       │   ├── rate-limit.ts    # 滑动窗口限流
│       │   └── config.ts        # 环境变量驱动配置
│       └── tsconfig.json
├── prisma/
│   ├── schema.prisma            # 数据库 Schema（唯一真相来源）
│   └── migrations/              # SQL 迁移
├── deploy/
│   └── cas.cool.nginx.conf      # Nginx 参考配置
├── ecosystem.config.cjs          # PM2 进程配置
└── .env.example                  # 环境变量模板
```

### 参与贡献

欢迎全球化学爱好者、开发者和科研工作者参与：

1. Fork 仓库
2. 阅读 [`AGENTS.md`](./AGENTS.md) 了解编码规范和架构约定
3. 创建功能分支（`git checkout -b feat/your-feature`）
4. 提交 Pull Request

**我们需要帮助：**
- i18n — 更多语言支持
- 化学特性 — 反应方程式渲染、安全数据表
- 性能优化 — 大规模部署的查询优化
- 移动端 — React Native 封装

### 开源协议

MIT License，详见 [`LICENSE`](./LICENSE)。

---

## English

### What is this

Chemistry knowledge is scattered across paywalled journals, proprietary
databases, private lab notebooks, and closed messaging groups. The people who
need it most — researchers, students, procurement officers, traders — waste
hours stitching together information that should flow freely.

**cas.cool is a social timeline for chemistry** — Twitter/X for the chemical
community. Post reactions, tag CAS numbers, share safety notes, follow
researchers, and discover what's happening across the global chemical world.

### Architecture

Two independent processes behind Nginx, sharing only the database:

| Process | Port | Role |
|---|---|---|
| Next.js 16 | 3000 | SSR pages, Server Actions, session auth, image pipeline |
| Public API | 8001 | `/api/v1/*` endpoints, token auth, independent rate limiting + pool |

Zero code-level coupling. Each process can be deployed, scaled, or replaced
independently.

### AI & API Support

Built-in agent-friendly Public API with token authentication, capability
manifest, and `/llms.txt` discovery. AI agents can discover the API, obtain a
token, and start reading/writing chemistry posts in a single session.

| Endpoint | Method | Auth |
|---|---|---|
| `/api/v1` | GET | None (discovery) |
| `/api/v1/manifest` | GET | None |
| `/api/v1/me` | GET | Bearer |
| `/api/v1/timeline` | GET | Bearer |
| `/api/v1/posts/:id` | GET | Bearer |
| `/api/v1/posts` | POST | Bearer (`post:write`) |
| `/api/v1/posts/:id/like` | POST/DELETE | Bearer |
| `/api/v1/posts/:id/bookmark` | POST/DELETE | Bearer |
| `/api/v1/users/:id/follow` | POST/DELETE | Bearer |

### Tech Stack

Next.js 16 · React 19 · Tailwind CSS 4 · PostgreSQL 16 · Prisma 7 ·
Node.js 22 · PM2 · Nginx

### Quick Start

```bash
git clone https://github.com/samelabs/cas.cool.git
cd cas.cool && npm install
npx prisma generate && npx prisma migrate deploy
cp .env.example .env   # set DATABASE_URL and JWT_SECRET
npm run build && npm run build:api
pm2 startOrReload ecosystem.config.cjs
```

### License

MIT — see [`LICENSE`](./LICENSE).

---

<div align="center">

## AIchem 开放计划

**cas.cool 是 samelabs AIchem 开放计划的一部分。**

AIchem 开放计划是一系列开源化学信息学工具和平台的集合，致力于打破
化学数据的围墙，让专业化学知识自由流动。

**我们的使命：** 打破化学数据的围墙。

**我们的承诺：** 任何人率先做成全球化的、活跃人数最多的化学信息流
平台，cas.cool 都将属于他。

化学信息的未来是开放的，未来由社区共建。

---

*Built by [samelabs](https://github.com/samelabs) · Powered by the global chemistry community*

</div>
