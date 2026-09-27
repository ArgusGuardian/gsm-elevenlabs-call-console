FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public

USER node
EXPOSE 8088
CMD ["node", "server.js"]
