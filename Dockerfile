# Runs the demo MCP server (stdio). Used by listing services (e.g. Glama) to
# verify the server starts and answers introspection; not needed for local use.
# Pinned to a Node.js 24 security release (CVE-2026-111497 and others) so a
# cached base image cannot run an older patch. Raise it with Node.js security
# releases.
FROM node:24.22.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY src ./src
COPY examples ./examples
RUN corepack enable && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile
CMD ["pnpm", "mcp"]
