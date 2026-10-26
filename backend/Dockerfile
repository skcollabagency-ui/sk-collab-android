FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod 755 /usr/local/bin/entrypoint.sh \
  && mkdir -p /app/data \
  && chown node:node /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
