FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Copy non-TS assets that tsc doesn't copy
RUN find /app/src -name "*.md" | while read f; do \
      dest="/app/dist${f#/app/src}"; \
      mkdir -p "$(dirname "$dest")"; \
      cp "$f" "$dest"; \
    done

FROM node:20-alpine AS runner
RUN apk add --no-cache git curl
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
# askpass.sh must be at /app/bin/askpass.sh
RUN mkdir -p /app/bin
COPY src/git/askpass.sh /app/bin/askpass.sh
RUN chmod +x /app/bin/askpass.sh
EXPOSE 4000
CMD ["node", "dist/index.js"]
