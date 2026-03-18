FROM nginx:1.27-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy website files
COPY . /usr/share/nginx/html

# Remove Docker/deployment files from served content
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/docker-stack.yml \
          /usr/share/nginx/html/nginx.conf \
          /usr/share/nginx/html/.env \
          /usr/share/nginx/html/.env.example \
          /usr/share/nginx/html/.gitignore \
          /usr/share/nginx/html/README.md \
    && rm -rf /usr/share/nginx/html/.git \
              /usr/share/nginx/html/.github \
              /usr/share/nginx/html/.claude \
              /usr/share/nginx/html/.trunk \
              /usr/share/nginx/html/api \
              /usr/share/nginx/html/energy-collector \
              /usr/share/nginx/html/wiki \
              /usr/share/nginx/html/scripts \
              /usr/share/nginx/html/stweg3/waschkueche-smart/README.md \
              /usr/share/nginx/html/stweg3/README.md \
              /usr/share/nginx/html/door-signs/README.md

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1
