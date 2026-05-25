FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN apk add --no-cache dumb-init
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
RUN mkdir -p /var/lib/homenet/storage && chown -R node:node /var/lib/homenet
USER node
EXPOSE 4000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
