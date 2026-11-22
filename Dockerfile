# SSPACE V10: build the packaged project and serve the full output on Render.
FROM node:22-alpine AS build
WORKDIR /build
RUN apk add --no-cache unzip
COPY SSPACE-V10-COMMUNAUTE-COLLECTIONS-MESSENGER-THEMES-ANIMES.zip /tmp/sspace.zip
RUN unzip -q /tmp/sspace.zip -d /build
WORKDIR /build/SSPACE-V10-VERCEL
RUN npm install --no-audit --no-fund
RUN npm run build

FROM nginx:1.27-alpine AS runtime
RUN cat > /etc/nginx/conf.d/default.conf <<'NGINX'
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    types {
        application/manifest+json webmanifest;
    }

    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri =404;
    }

    location = /messenger/sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri =404;
    }

    location = /manifest.webmanifest {
        add_header Cache-Control "no-cache";
        try_files $uri =404;
    }

    location /messenger/ {
        try_files $uri $uri/ /messenger/index.html;
    }

    location / {
        try_files $uri $uri/ =404;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINX
COPY --from=build /build/SSPACE-V10-VERCEL/dist/ /usr/share/nginx/html/
EXPOSE 80
