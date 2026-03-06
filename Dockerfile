FROM node:20

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json package-lock.json ./
RUN npm ci --include=optional

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
