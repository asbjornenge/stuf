FROM node:22.5.0-alpine

RUN mkdir /app
WORKDIR /app

ADD package.json package-lock.json /app/
RUN npm install

ADD index.js db.js ws.js scheduler.js payments.js config.js /app/
ADD routes/ /app/routes/
ADD migrations/ /app/migrations/

EXPOSE 3000

CMD ["node", "index.js"]
