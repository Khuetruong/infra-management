FROM node:22-slim
WORKDIR /app
COPY server/ /app/server/
COPY agent/ /app/agent/
ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
WORKDIR /app/server
CMD ["node", "--no-warnings", "src/index.js"]
