# Stage 2: Build the NestJS application
FROM node:20-alpine AS nestjs-builder
RUN apk add --no-cache git
RUN corepack enable && corepack prepare yarn@3.6.4 --activate

WORKDIR /app

RUN chown node /app
RUN chown node .

USER node

# Copy the package.json and yarn.lock to the working directory
#COPY fasset-user-ui-backend/package.json fasset-user-ui-backend/yarn.lock ./

#RUN yarn

# Copy the rest of the application source code
COPY --chown=node . .

# Set permissions for secrets.json
#RUN chmod 600 ./src/secrets.json

RUN git submodule update --init --recursive

WORKDIR /app/fasset-bots

RUN yarn
RUN yarn build

WORKDIR /app

# Build the NestJS application
RUN yarn
#RUN yarn build

# Expose port 3001
EXPOSE 3001
#Build with sudo docker build -f Dockerfile -t demodapp ../../
# Start the application
#CMD ["yarn", "run", "start"]
