# Stage 2: Build the NestJS application
FROM node:20-alpine AS nestjs-builder
RUN apk add --no-cache git
RUN corepack enable && corepack prepare yarn@3.6.4 --activate

WORKDIR /app/fasset-user-ui-backend

# Copy the package.json and yarn.lock to the working directory
COPY fasset-user-ui-backend/package.json fasset-user-ui-backend/yarn.lock ./

RUN yarn

# Copy the rest of the application source code
COPY fasset-user-ui-backend ./
RUN yarn

# Copy and set permissions for secrets.json
COPY fasset-user-ui-backend/src/secrets.json ./src/secrets.json
RUN chmod 600 ./src/secrets.json

WORKDIR /app/fasset-user-ui-backend/fasset-bots

RUN yarn

RUN yarn build

WORKDIR /app/fasset-user-ui-backend

# Build the NestJS application
RUN yarn build

# Expose port 3001
EXPOSE 3001
#Build with sudo docker build -f Dockerfile -t demodapp ../../
# Start the application
CMD ["yarn", "run", "start"]
