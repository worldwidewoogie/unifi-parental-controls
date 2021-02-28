FROM node:lts-alpine
RUN mkdir -p /node/config
WORKDIR /node
COPY package.json index.js lib.js LICENSE README.md ./
RUN npm install
EXPOSE 8080
CMD [ "node", "index.js" ]