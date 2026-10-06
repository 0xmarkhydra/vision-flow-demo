FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.mjs index.html app.js styles.css ./
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
