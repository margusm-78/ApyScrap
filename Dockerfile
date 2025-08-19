FROM apify/actor-node-playwright-chrome:latest
COPY package*.json ./
RUN npm --quiet set progress=false && npm install --omit=dev
COPY . ./
CMD ["node", "src/main.js"]
