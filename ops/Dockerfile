# focuspin-backend — образ рантайма. Сборки нет: bun исполняет TypeScript напрямую.
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock tsconfig.json bunfig.toml .env.example ./
COPY src ./src

# Dev-зависимости (typescript, @types/bun) ставим ДО NODE_ENV=production:
# bun при NODE_ENV=production пропустил бы их. Рантайму они не мешают,
# а CI может запускать typecheck прямо в контейнере.
RUN bun install --frozen-lockfile

ENV NODE_ENV=production
USER bun
EXPOSE 8080

# HEALTHCHECK стучится в собственный healthz; PORT можно переопределить через env.
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SQLite-БД кладите в том: DATABASE_PATH=/data/focuspin.db (см. ops/docker-compose.yml).
# В БД только HMAC-хеши и счётчики — том можно терять без боли.
CMD ["bun", "run", "src/main.ts"]
