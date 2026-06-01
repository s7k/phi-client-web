# phi-web フロントエンド + エッジ(nginx)
# build context = ./frontend
# Stage1: Vite ビルド(静的成果物は dist/。JS/CSSは dist/app/, index.html は dist/)
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage2: nginx で静的配信 + /api,/ws,/assets を backend へプロキシ
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
