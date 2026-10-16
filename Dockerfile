FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY index.html ./public/index.html
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data TRUST_PROXY=1
EXPOSE 3000
CMD ["node", "server.js"]
