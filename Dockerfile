FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js ./
COPY data ./data
COPY public ./public
EXPOSE 8080
ENV PORT=8080
CMD ["node", "server.js"]
