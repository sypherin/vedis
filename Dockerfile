FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist/ dist/

# Cloud Run sets PORT env var
ENV PORT=8080
EXPOSE 8080

# For SSE mode (future), entry point would be the HTTP server
# For now, the container can be used as a base image or with custom entrypoint
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["proxy"]
