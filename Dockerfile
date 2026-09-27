FROM node:20-alpine

RUN apk add --no-cache smartmontools util-linux

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY lib ./lib
COPY public ./public
COPY server.js ./

ENV PORT=3300
EXPOSE 3300

CMD ["node", "server.js"]
