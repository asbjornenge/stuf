#### build ####

FROM node:22.5.0 AS builder
ARG APP_VERSION=dev
RUN npm install -g node-static
RUN mkdir /app
ADD src/ /app/src
ADD public/ /app/public
ADD index.html /app/index.html
ADD package.json /app/package.json
ADD vite.config.js /app/vite.config.js
ADD package-lock.json /app/package-lock.json
WORKDIR /app
RUN npm install vite --force
RUN npm install --force
RUN sed -i "s/stuf-v1/stuf-${APP_VERSION}/" public/sw.js
ENV APP_VERSION=${APP_VERSION}
RUN npm run build

#### final ####

FROM node:22.5.0-alpine
RUN npm install -g node-static
COPY --from=builder /app/dist/ /app

CMD ["static","-a","0.0.0.0","app"]
