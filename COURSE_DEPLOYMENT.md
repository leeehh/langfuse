# rCore 课程会话服务部署

本部署包含两个服务：

- **Langfuse**：保存和查看 agent trace；
- **course-trace-auth**：提供学生注册、助教管理和带身份校验的 trace 上传入口。

`course-trace-auth` 是独立的配套源码目录，需要与 Langfuse 部署在同一台 Docker
主机。下文使用示例域名，部署时替换为自己的 HTTPS 域名。

## 1. 部署 Langfuse

完整的环境变量说明以
[Langfuse 官方 Docker Compose 文档](https://langfuse.com/self-hosting/docker-compose)
为准。本 fork 包含尚未进入官方镜像的源码修改。为了保留官方 Compose 的运行配置，
同时从当前源码构建 Web 和 worker，在仓库根目录创建 `compose.source.yml`：

```yaml
services:
  langfuse-web:
    image: langfuse-local-web:latest
    build:
      context: .
      dockerfile: ./web/Dockerfile

  langfuse-worker:
    image: langfuse-local-worker:latest
    build:
      context: .
      dockerfile: ./worker/Dockerfile
```

首次部署时，在 Langfuse 仓库根目录创建权限为 `0600` 的 `.env`。至少配置：

```dotenv
NEXTAUTH_URL=https://langfuse.example.edu
NEXTAUTH_SECRET=<random-secret>
SALT=<random-salt>
ENCRYPTION_KEY=<64-character-hex-key>

POSTGRES_PASSWORD=<postgres-password>
DATABASE_URL=postgresql://postgres:<postgres-password>@postgres:5432/postgres
CLICKHOUSE_PASSWORD=<clickhouse-password>
REDIS_AUTH=<redis-password>

MINIO_ROOT_USER=minio
MINIO_ROOT_PASSWORD=<minio-password>
LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=<minio-password>
LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=<minio-password>
LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY=<minio-password>
```

可使用以下命令生成随机值：

```bash
openssl rand -base64 32  # NEXTAUTH_SECRET、SALT
openssl rand -hex 32     # ENCRYPTION_KEY
openssl rand -hex 24     # 各内部服务密码
chmod 600 .env
```

构建并启动：

```bash
docker compose --project-name langfuse \
  -f docker-compose.yml -f compose.source.yml config --quiet
docker compose --project-name langfuse \
  -f docker-compose.yml -f compose.source.yml up -d --build --wait
```

检查服务：

```bash
docker compose --project-name langfuse \
  -f docker-compose.yml -f compose.source.yml ps
curl -fsS http://127.0.0.1:3000/api/public/health
curl -fsS http://127.0.0.1:3000/api/public/ready
curl -fsS http://127.0.0.1:3030/api/health
```

通过 HTTPS reverse proxy 将 Langfuse 域名转发到 Web 服务的 `3000` 端口。数据库、
Redis、ClickHouse 和 worker 端口不应向公网开放。

首次进入 Langfuse 后，创建课程 project，并为身份服务创建一组专用 project API
keys。后续配置中的 `LANGFUSE_UPSTREAM_PUBLIC_KEY` 和
`LANGFUSE_UPSTREAM_SECRET_KEY` 使用这组凭据；不得将这组服务端凭据发给学生。

## 2. 部署学生注册与助教管理服务

进入 `course-trace-auth` 源码目录，创建权限为 `0600` 的 `.env`：

```dotenv
ADMIN_PASSWORD=<initial-super-admin-password>
SESSION_SECRET=<64-character-hex-secret>
CREDENTIAL_ENCRYPTION_KEY=<fernet-key>

TOKEN_BASE_URL=https://trace-auth.example.edu
PORTAL_PUBLIC_URL=https://trace-auth.example.edu

LANGFUSE_UPSTREAM_PUBLIC_KEY=pk-lf-...
LANGFUSE_UPSTREAM_SECRET_KEY=sk-lf-...

REGISTRATION_OPEN=true
REGISTRATION_LIMIT_PER_HOUR=100
TRUST_PROXY_HEADERS=true
COOKIE_SECURE=true

COURSE_UID=<host-user-id>
COURSE_GID=<host-group-id>
```

生成身份服务密钥并查询运行用户 UID/GID：

```bash
openssl rand -base64 24                  # ADMIN_PASSWORD
openssl rand -hex 32                     # SESSION_SECRET
openssl rand -base64 32 | tr '+/' '-_'  # CREDENTIAL_ENCRYPTION_KEY
id -u                                    # COURSE_UID
id -g                                    # COURSE_GID
chmod 600 .env
```

`TOKEN_BASE_URL` 是写入学生 token JSON 的上传服务 origin，必须使用 HTTPS，不要包含
API 路径或末尾斜杠。`CREDENTIAL_ENCRYPTION_KEY` 必须长期保持不变，否则助教无法恢复
已签发的 token JSON。

身份服务默认连接名为 `langfuse_default` 的 Docker network。启动前确认该网络存在：

```bash
docker network inspect langfuse_default >/dev/null
mkdir -p data/private
chmod 700 data/private

docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d --build --wait
docker compose -f compose.yml ps
curl -fsS http://127.0.0.1:8088/healthz
```

如果 Langfuse 使用了其他 Compose project name，需要同步修改 `compose.yml` 中
external network 的名称。

通过 HTTPS reverse proxy 将 `https://trace-auth.example.edu` 转发到
`http://127.0.0.1:8088`，并保留 `Authorization` 请求头。不要公开 Collector 的
`4318` 端口。服务入口为：

- `/register`：学生注册并下载个人 token JSON；
- `/admin/login`：助教登录；
- `/api/public/otel/v1/traces`：agent 上传 trace；
- `/healthz`：健康检查。

首次创建数据库时，`ADMIN_PASSWORD` 用于创建唯一的超级助教账户 `00000000`。
超级助教可以在 `/admin/assistants` 添加或删除普通助教；普通助教只能在
`/admin` 管理学生。修改已有部署的 `ADMIN_PASSWORD` 不会自动修改数据库中的密码。

## 3. 更新、日志与备份

Langfuse：

```bash
docker compose --project-name langfuse \
  -f docker-compose.yml -f compose.source.yml up -d --build --wait
docker compose --project-name langfuse \
  -f docker-compose.yml -f compose.source.yml \
  logs --tail=200 -f langfuse-web langfuse-worker
```

学生注册与助教服务：

```bash
docker compose -f compose.yml up -d --build --wait
docker compose -f compose.yml logs --tail=200 -f portal collector
```

需要备份：

- Langfuse 的 `.env` 和 Docker named volumes；
- 身份服务的 `.env` 和 `data/private/registry.sqlite3`。

对 SQLite 数据库执行文件级备份前，先停止 `portal`。不要执行
`docker compose down --volumes`，除非确定要永久删除 Langfuse 数据。
